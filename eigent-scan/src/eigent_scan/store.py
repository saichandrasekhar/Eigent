"""SQLite-based scan result persistence for Eigent scanner."""

from __future__ import annotations

import json
import sqlite3
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from eigent_scan.models import (
    Agent,
    AgentSource,
    AuthStatus,
    Finding,
    ScanResult,
    Severity,
    TransportType,
)


@dataclass
class ScanResultSummary:
    """Lightweight summary of a stored scan result."""

    id: str
    timestamp: datetime
    targets: str
    total_agents: int
    total_findings: int
    critical_findings: int
    overall_risk: str


class ScanStore:
    """Manages a SQLite database for persisting scan results.

    Database is stored at ``~/.eigent/scans.db`` by default.  Tables are
    auto-created on first use.
    """

    def __init__(self, db_path: str | Path | None = None) -> None:
        if db_path is None:
            db_dir = Path.home() / ".eigent"
            db_dir.mkdir(parents=True, exist_ok=True)
            db_path = db_dir / "scans.db"
        self.db_path = Path(db_path)
        self._ensure_tables()

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self.db_path))
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        return conn

    def _ensure_tables(self) -> None:
        conn = self._connect()
        try:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS scans (
                    id              TEXT PRIMARY KEY,
                    timestamp       TEXT NOT NULL,
                    targets         TEXT NOT NULL DEFAULT '',
                    total_agents    INTEGER NOT NULL DEFAULT 0,
                    total_findings  INTEGER NOT NULL DEFAULT 0,
                    critical_findings INTEGER NOT NULL DEFAULT 0,
                    overall_risk    TEXT NOT NULL DEFAULT 'info',
                    data_json       TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS agents (
                    id          TEXT PRIMARY KEY,
                    scan_id     TEXT NOT NULL,
                    name        TEXT NOT NULL,
                    source      TEXT NOT NULL,
                    transport   TEXT NOT NULL DEFAULT 'unknown',
                    auth_status TEXT NOT NULL DEFAULT 'unknown',
                    config_path TEXT,
                    FOREIGN KEY (scan_id) REFERENCES scans(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS findings (
                    id          TEXT PRIMARY KEY,
                    scan_id     TEXT NOT NULL,
                    agent_name  TEXT NOT NULL,
                    severity    TEXT NOT NULL,
                    title       TEXT NOT NULL,
                    description TEXT NOT NULL DEFAULT '',
                    FOREIGN KEY (scan_id) REFERENCES scans(id) ON DELETE CASCADE
                );

                CREATE INDEX IF NOT EXISTS idx_agents_scan_id ON agents(scan_id);
                CREATE INDEX IF NOT EXISTS idx_findings_scan_id ON findings(scan_id);
                CREATE INDEX IF NOT EXISTS idx_scans_timestamp ON scans(timestamp);
                """
            )
            conn.commit()
        finally:
            conn.close()

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def save_result(self, result: ScanResult) -> str:
        """Serialize and store a scan result, returning the scan_id."""
        scan_id = result.scan_id or uuid.uuid4().hex[:16]
        ts = result.timestamp.isoformat()
        targets = ",".join(result.targets_scanned)
        data_json = result.model_dump_json()

        conn = self._connect()
        try:
            conn.execute(
                """
                INSERT OR REPLACE INTO scans
                    (id, timestamp, targets, total_agents, total_findings,
                     critical_findings, overall_risk, data_json)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    scan_id,
                    ts,
                    targets,
                    result.total_agents,
                    len(result.findings),
                    result.critical_findings,
                    result.overall_risk.value,
                    data_json,
                ),
            )

            # Persist agents
            for agent in result.agents:
                agent_id = uuid.uuid4().hex[:16]
                conn.execute(
                    """
                    INSERT INTO agents
                        (id, scan_id, name, source, transport, auth_status, config_path)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        agent_id,
                        scan_id,
                        agent.name,
                        agent.source.value,
                        agent.transport.value,
                        agent.auth_status.value,
                        agent.config_path,
                    ),
                )

            # Persist findings
            for finding in result.findings:
                finding_id = uuid.uuid4().hex[:16]
                conn.execute(
                    """
                    INSERT INTO findings
                        (id, scan_id, agent_name, severity, title, description)
                    VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (
                        finding_id,
                        scan_id,
                        finding.agent_name,
                        finding.severity.value,
                        finding.title,
                        finding.description,
                    ),
                )

            conn.commit()
        finally:
            conn.close()

        return scan_id

    def get_result(self, scan_id: str) -> ScanResult:
        """Retrieve a stored scan result by its id.

        Raises ``KeyError`` if the scan_id is not found.
        """
        conn = self._connect()
        try:
            row = conn.execute(
                "SELECT data_json FROM scans WHERE id = ?", (scan_id,)
            ).fetchone()
            if row is None:
                raise KeyError(f"Scan result not found: {scan_id}")
            return ScanResult.model_validate_json(row["data_json"])
        finally:
            conn.close()

    def list_results(self, limit: int = 20) -> list[ScanResultSummary]:
        """List recent scans with summary info, newest first."""
        conn = self._connect()
        try:
            rows = conn.execute(
                """
                SELECT id, timestamp, targets, total_agents, total_findings,
                       critical_findings, overall_risk
                FROM scans
                ORDER BY timestamp DESC
                LIMIT ?
                """,
                (limit,),
            ).fetchall()

            return [
                ScanResultSummary(
                    id=r["id"],
                    timestamp=datetime.fromisoformat(r["timestamp"]),
                    targets=r["targets"],
                    total_agents=r["total_agents"],
                    total_findings=r["total_findings"],
                    critical_findings=r["critical_findings"],
                    overall_risk=r["overall_risk"],
                )
                for r in rows
            ]
        finally:
            conn.close()

    def get_latest(self) -> ScanResult | None:
        """Return the most recent scan result, or ``None`` if the store is empty."""
        conn = self._connect()
        try:
            row = conn.execute(
                "SELECT data_json FROM scans ORDER BY timestamp DESC LIMIT 1"
            ).fetchone()
            if row is None:
                return None
            return ScanResult.model_validate_json(row["data_json"])
        finally:
            conn.close()
