"""Configuration file support for Eigent scanner."""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

from eigent_scan.alerts import AlertChannel, AlertConfig
from eigent_scan.models import Severity

logger = logging.getLogger(__name__)

_DEFAULT_GLOBAL_PATH = Path.home() / ".eigent" / "config.yaml"
_DEFAULT_PROJECT_PATH = Path(".eigent.yaml")

_SEVERITY_MAP = {
    "critical": Severity.CRITICAL,
    "high": Severity.HIGH,
    "medium": Severity.MEDIUM,
    "low": Severity.LOW,
    "info": Severity.INFO,
}


@dataclass
class ScanConfig:
    """Scan-related configuration."""

    targets: list[str] = field(default_factory=lambda: ["mcp", "process"])
    save_results: bool = True


@dataclass
class EigentConfig:
    """Top-level Eigent configuration loaded from YAML."""

    alert_configs: list[AlertConfig] = field(default_factory=list)
    scan: ScanConfig = field(default_factory=ScanConfig)
    raw: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> EigentConfig:
        """Parse a configuration dictionary (from YAML) into an EigentConfig."""
        alert_configs: list[AlertConfig] = []

        alerts_section = data.get("alerts", {})
        if isinstance(alerts_section, dict):
            for channel_name, channel_data in alerts_section.items():
                if not isinstance(channel_data, dict):
                    continue

                channel_name_lower = channel_name.lower()
                try:
                    channel = AlertChannel(channel_name_lower)
                except ValueError:
                    channel = AlertChannel.GENERIC

                min_sev_str = str(channel_data.get("min_severity", "high")).lower()
                min_severity = _SEVERITY_MAP.get(min_sev_str, Severity.HIGH)

                webhook_url = channel_data.get("webhook_url", "")
                routing_key = channel_data.get("routing_key")

                # PagerDuty uses the events API endpoint; routing_key is required
                if channel == AlertChannel.PAGERDUTY:
                    if not routing_key:
                        logger.warning("PagerDuty config missing routing_key, skipping")
                        continue
                    webhook_url = webhook_url or "https://events.pagerduty.com/v2/enqueue"

                if not webhook_url:
                    logger.warning("Alert config for '%s' missing webhook_url, skipping", channel_name)
                    continue

                alert_configs.append(
                    AlertConfig(
                        webhook_url=webhook_url,
                        channel=channel,
                        min_severity=min_severity,
                        routing_key=routing_key,
                    )
                )

        scan_section = data.get("scan", {})
        scan_config = ScanConfig()
        if isinstance(scan_section, dict):
            targets = scan_section.get("targets")
            if isinstance(targets, list):
                scan_config.targets = [str(t) for t in targets]
            save = scan_section.get("save_results")
            if save is not None:
                scan_config.save_results = bool(save)

        return cls(alert_configs=alert_configs, scan=scan_config, raw=data)


def load_config(
    global_path: Path | None = None,
    project_path: Path | None = None,
) -> EigentConfig:
    """Load configuration from YAML files.

    Checks the project-level file first (``.eigent.yaml``), then the global
    file (``~/.eigent/config.yaml``).  The first file found wins (no merging).
    Returns a default ``EigentConfig`` if neither file exists.
    """
    candidates = [
        project_path or _DEFAULT_PROJECT_PATH,
        global_path or _DEFAULT_GLOBAL_PATH,
    ]

    for path in candidates:
        resolved = path if path.is_absolute() else Path.cwd() / path
        if resolved.is_file():
            logger.debug("Loading config from %s", resolved)
            try:
                text = resolved.read_text(encoding="utf-8")
                data = yaml.safe_load(text)
                if isinstance(data, dict):
                    return EigentConfig.from_dict(data)
                logger.warning("Config file %s did not contain a mapping, using defaults", resolved)
            except Exception as exc:
                logger.warning("Failed to parse config %s: %s", resolved, exc)
            break

    return EigentConfig()
