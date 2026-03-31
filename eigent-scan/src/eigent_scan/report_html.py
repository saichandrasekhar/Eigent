"""Standalone HTML report generator for Eigent scan results.

Produces a single-file HTML report with embedded CSS and inline SVG charts.
Designed to look professional enough for board-level security presentations.
"""

from __future__ import annotations

import html
import math

from eigent_scan import __version__
from eigent_scan.compliance import ComplianceTag, get_compliance_tags
from eigent_scan.diff import ScanDiff
from eigent_scan.models import AuthStatus, ScanResult, Severity


# ---------------------------------------------------------------------------
# Color palette
# ---------------------------------------------------------------------------
_SEVERITY_COLORS: dict[Severity, str] = {
    Severity.CRITICAL: "#ff3b5c",
    Severity.HIGH: "#ff6b35",
    Severity.MEDIUM: "#ffc233",
    Severity.LOW: "#38bdf8",
    Severity.INFO: "#94a3b8",
}

_SEVERITY_BG: dict[Severity, str] = {
    Severity.CRITICAL: "rgba(255,59,92,0.12)",
    Severity.HIGH: "rgba(255,107,53,0.12)",
    Severity.MEDIUM: "rgba(255,194,51,0.12)",
    Severity.LOW: "rgba(56,189,248,0.12)",
    Severity.INFO: "rgba(148,163,184,0.10)",
}

_AUTH_COLORS: dict[AuthStatus, str] = {
    AuthStatus.NONE: "#ff3b5c",
    AuthStatus.API_KEY: "#ffc233",
    AuthStatus.OAUTH: "#34d399",
    AuthStatus.IAM: "#34d399",
    AuthStatus.UNKNOWN: "#94a3b8",
}


def _esc(text: str) -> str:
    """HTML-escape a string."""
    return html.escape(str(text))


# ---------------------------------------------------------------------------
# SVG Pie Chart
# ---------------------------------------------------------------------------
def _pie_chart_svg(counts: dict[str, tuple[int, str]], size: int = 220) -> str:
    """Generate an inline SVG donut chart.

    *counts* maps label -> (count, hex_color).
    """
    total = sum(c for c, _ in counts.values())
    if total == 0:
        return ""

    cx, cy, r = size // 2, size // 2, size // 2 - 20
    inner_r = r * 0.55
    slices: list[str] = []
    legend_items: list[str] = []
    start_angle = -90.0  # start from 12 o'clock

    for label, (count, color) in counts.items():
        if count == 0:
            continue
        frac = count / total
        angle = frac * 360.0
        end_angle = start_angle + angle

        # Large arc flag
        large = 1 if angle > 180 else 0

        # Outer arc
        x1o = cx + r * math.cos(math.radians(start_angle))
        y1o = cy + r * math.sin(math.radians(start_angle))
        x2o = cx + r * math.cos(math.radians(end_angle))
        y2o = cy + r * math.sin(math.radians(end_angle))

        # Inner arc (reverse direction for donut hole)
        x1i = cx + inner_r * math.cos(math.radians(end_angle))
        y1i = cy + inner_r * math.sin(math.radians(end_angle))
        x2i = cx + inner_r * math.cos(math.radians(start_angle))
        y2i = cy + inner_r * math.sin(math.radians(start_angle))

        path = (
            f"M {x1o:.2f} {y1o:.2f} "
            f"A {r} {r} 0 {large} 1 {x2o:.2f} {y2o:.2f} "
            f"L {x1i:.2f} {y1i:.2f} "
            f"A {inner_r} {inner_r} 0 {large} 0 {x2i:.2f} {y2i:.2f} Z"
        )
        slices.append(
            f'<path d="{path}" fill="{color}" opacity="0.92">'
            f"<title>{_esc(label)}: {count}</title></path>"
        )

        pct = f"{frac * 100:.0f}%"
        legend_items.append(
            f'<div class="legend-item">'
            f'<span class="legend-dot" style="background:{color}"></span>'
            f'<span class="legend-label">{_esc(label)}</span>'
            f'<span class="legend-value">{count} ({pct})</span>'
            f"</div>"
        )

        start_angle = end_angle

    center_text = (
        f'<text x="{cx}" y="{cy - 6}" text-anchor="middle" '
        f'fill="#e2e8f0" font-family="Outfit,sans-serif" font-size="28" font-weight="700">'
        f"{total}</text>"
        f'<text x="{cx}" y="{cy + 16}" text-anchor="middle" '
        f'fill="#94a3b8" font-family="Outfit,sans-serif" font-size="11" font-weight="400">'
        f"FINDINGS</text>"
    )

    svg = (
        f'<svg viewBox="0 0 {size} {size}" width="{size}" height="{size}" '
        f'xmlns="http://www.w3.org/2000/svg">{"".join(slices)}{center_text}</svg>'
    )

    return (
        f'<div class="chart-container">'
        f'<div class="chart-svg">{svg}</div>'
        f'<div class="chart-legend">{"".join(legend_items)}</div>'
        f"</div>"
    )


# ---------------------------------------------------------------------------
# Main render function
# ---------------------------------------------------------------------------
def render_html(result: ScanResult, diff: ScanDiff | None = None) -> str:
    """Render a complete standalone HTML report string."""
    risk = result.overall_risk
    risk_color = _SEVERITY_COLORS[risk]
    timestamp = result.timestamp.strftime("%B %d, %Y at %H:%M:%S UTC")
    shadow_count = sum(
        1 for a in result.agents if a.source.value.startswith("live")
        or a.metadata.get("shadow", False)
    )

    sections: list[str] = [
        _section_header(result, risk, risk_color, timestamp),
        _section_summary(result, shadow_count),
    ]

    if diff is not None:
        sections.append(_section_risk_trend(diff))

    # Pie chart
    severity_counts: dict[str, tuple[int, str]] = {}
    for sev in Severity:
        count = sum(1 for f in result.findings if f.severity == sev)
        if count > 0:
            severity_counts[sev.value.upper()] = (count, _SEVERITY_COLORS[sev])
    if severity_counts:
        sections.append(
            f'<section class="report-section">'
            f'<h2 class="section-title">Risk Distribution</h2>'
            f"{_pie_chart_svg(severity_counts)}"
            f"</section>"
        )

    if result.agents:
        sections.append(_section_agents_table(result))

    if result.findings:
        sections.append(_section_findings(result))
        sections.append(_section_compliance(result))
        sections.append(_section_recommendations(result))

    sections.append(_section_footer(result))

    body = "\n".join(sections)
    return _wrap_page(body, risk, risk_color)


# ---------------------------------------------------------------------------
# Page wrapper with embedded CSS
# ---------------------------------------------------------------------------
def _wrap_page(body: str, risk: Severity, risk_color: str) -> str:
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Eigent Security Report</title>
<style>
/* ── Fonts (Google Fonts embedded via CDN) ── */
@import url('https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap');

/* ── Reset & Base ── */
*, *::before, *::after {{ box-sizing: border-box; margin: 0; padding: 0; }}
html {{ font-size: 15px; -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; }}
body {{
  font-family: 'Outfit', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  background: #0a0e1a;
  color: #e2e8f0;
  line-height: 1.6;
  min-height: 100vh;
}}

/* ── Subtle animated gradient background ── */
body::before {{
  content: '';
  position: fixed;
  inset: 0;
  background:
    radial-gradient(ellipse 80% 60% at 20% 10%, rgba(56,189,248,0.06) 0%, transparent 60%),
    radial-gradient(ellipse 60% 50% at 80% 90%, rgba(139,92,246,0.05) 0%, transparent 60%);
  pointer-events: none;
  z-index: 0;
}}

.report-wrapper {{
  position: relative;
  z-index: 1;
  max-width: 1080px;
  margin: 0 auto;
  padding: 40px 32px 60px;
}}

/* ── Header ── */
.report-header {{
  text-align: center;
  margin-bottom: 48px;
  padding: 48px 32px 40px;
  background: linear-gradient(135deg, rgba(15,23,42,0.95) 0%, rgba(15,23,42,0.8) 100%);
  border: 1px solid rgba(148,163,184,0.1);
  border-radius: 20px;
  backdrop-filter: blur(12px);
  position: relative;
  overflow: hidden;
}}
.report-header::before {{
  content: '';
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 3px;
  background: linear-gradient(90deg, {risk_color}, rgba(139,92,246,0.8), {risk_color});
  border-radius: 20px 20px 0 0;
}}

.logo {{
  font-size: 1.6rem;
  font-weight: 800;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  margin-bottom: 4px;
}}
.logo-icon {{ color: #38bdf8; }}
.logo-text {{ color: #f1f5f9; }}

.report-subtitle {{
  font-size: 0.85rem;
  color: #64748b;
  letter-spacing: 0.15em;
  text-transform: uppercase;
  margin-bottom: 24px;
}}

.header-meta {{
  display: flex;
  justify-content: center;
  gap: 32px;
  flex-wrap: wrap;
  font-size: 0.82rem;
  color: #94a3b8;
}}
.header-meta span {{ display: inline-flex; align-items: center; gap: 6px; }}

.risk-badge {{
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 24px;
  border-radius: 100px;
  font-weight: 700;
  font-size: 0.9rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  margin-top: 20px;
  border: 1.5px solid;
}}

/* ── Sections ── */
.report-section {{
  background: rgba(15,23,42,0.7);
  border: 1px solid rgba(148,163,184,0.08);
  border-radius: 16px;
  padding: 32px;
  margin-bottom: 24px;
  backdrop-filter: blur(8px);
}}

.section-title {{
  font-size: 1.1rem;
  font-weight: 700;
  color: #f1f5f9;
  margin-bottom: 24px;
  padding-bottom: 12px;
  border-bottom: 1px solid rgba(148,163,184,0.1);
  display: flex;
  align-items: center;
  gap: 10px;
}}
.section-title::before {{
  content: '';
  width: 4px;
  height: 20px;
  border-radius: 4px;
  background: #38bdf8;
  flex-shrink: 0;
}}

/* ── Summary Cards ── */
.summary-grid {{
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 16px;
}}
.summary-card {{
  background: rgba(30,41,59,0.6);
  border: 1px solid rgba(148,163,184,0.08);
  border-radius: 12px;
  padding: 20px 24px;
  text-align: center;
  transition: border-color 0.2s;
}}
.summary-card:hover {{ border-color: rgba(56,189,248,0.3); }}
.summary-card .card-value {{
  font-size: 2.2rem;
  font-weight: 800;
  line-height: 1.1;
  font-family: 'JetBrains Mono', monospace;
}}
.summary-card .card-label {{
  font-size: 0.78rem;
  color: #94a3b8;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  margin-top: 6px;
}}

/* ── Risk Trend ── */
.trend-box {{
  display: flex;
  align-items: center;
  gap: 20px;
  flex-wrap: wrap;
  padding: 20px 24px;
  background: rgba(30,41,59,0.5);
  border-radius: 12px;
  border: 1px solid rgba(148,163,184,0.08);
}}
.trend-item {{
  font-size: 0.9rem;
  color: #cbd5e1;
}}
.trend-item strong {{ color: #f1f5f9; }}
.trend-up {{ color: #ff6b35; }}
.trend-down {{ color: #34d399; }}
.trend-neutral {{ color: #94a3b8; }}

/* ── Chart ── */
.chart-container {{
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 40px;
  flex-wrap: wrap;
  padding: 16px 0;
}}
.chart-svg {{ flex-shrink: 0; }}
.chart-legend {{ display: flex; flex-direction: column; gap: 10px; min-width: 180px; }}
.legend-item {{ display: flex; align-items: center; gap: 10px; font-size: 0.85rem; }}
.legend-dot {{
  width: 12px; height: 12px; border-radius: 3px; flex-shrink: 0;
}}
.legend-label {{ color: #cbd5e1; flex: 1; }}
.legend-value {{ color: #94a3b8; font-family: 'JetBrains Mono', monospace; font-size: 0.8rem; }}

/* ── Agent Table ── */
.agent-table {{
  width: 100%;
  border-collapse: separate;
  border-spacing: 0;
  font-size: 0.85rem;
}}
.agent-table thead th {{
  background: rgba(30,41,59,0.8);
  color: #94a3b8;
  font-weight: 600;
  font-size: 0.72rem;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  padding: 12px 16px;
  text-align: left;
  border-bottom: 1px solid rgba(148,163,184,0.1);
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
  position: sticky;
  top: 0;
}}
.agent-table thead th:first-child {{ border-radius: 10px 0 0 0; }}
.agent-table thead th:last-child {{ border-radius: 0 10px 0 0; }}
.agent-table thead th:hover {{ color: #e2e8f0; }}
.agent-table thead th .sort-arrow {{ opacity: 0.4; margin-left: 4px; font-size: 0.7rem; }}

.agent-table tbody tr {{
  transition: background 0.15s;
}}
.agent-table tbody tr:hover {{
  background: rgba(56,189,248,0.04);
}}
.agent-table tbody td {{
  padding: 11px 16px;
  border-bottom: 1px solid rgba(148,163,184,0.05);
  color: #cbd5e1;
  vertical-align: middle;
}}
.agent-table tbody td:first-child {{ color: #f1f5f9; font-weight: 600; }}

.auth-badge {{
  display: inline-block;
  padding: 2px 10px;
  border-radius: 100px;
  font-size: 0.72rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}}

.config-path {{
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.75rem;
  color: #64748b;
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}}

/* ── Findings ── */
.finding-card {{
  border-radius: 12px;
  padding: 20px 24px;
  margin-bottom: 12px;
  border-left: 4px solid;
  transition: transform 0.15s, box-shadow 0.15s;
}}
.finding-card:hover {{
  transform: translateX(3px);
  box-shadow: 0 4px 24px rgba(0,0,0,0.2);
}}
.finding-header {{
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 8px;
}}
.finding-severity {{
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.7rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  padding: 3px 10px;
  border-radius: 6px;
  flex-shrink: 0;
}}
.finding-title {{
  font-weight: 600;
  color: #f1f5f9;
  font-size: 0.95rem;
}}
.finding-agent {{
  font-size: 0.78rem;
  color: #64748b;
  font-family: 'JetBrains Mono', monospace;
}}
.finding-desc {{
  color: #94a3b8;
  font-size: 0.85rem;
  margin: 6px 0;
  line-height: 1.5;
}}
.finding-rec {{
  font-size: 0.82rem;
  color: #38bdf8;
  margin-top: 8px;
  padding: 8px 12px;
  background: rgba(56,189,248,0.06);
  border-radius: 8px;
  border: 1px solid rgba(56,189,248,0.1);
}}
.finding-rec::before {{
  content: 'Recommendation: ';
  font-weight: 600;
  color: rgba(56,189,248,0.7);
}}

/* ── Compliance ── */
.compliance-grid {{
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
  gap: 12px;
}}
.compliance-card {{
  background: rgba(30,41,59,0.5);
  border: 1px solid rgba(148,163,184,0.08);
  border-radius: 10px;
  padding: 16px 20px;
}}
.compliance-framework {{
  font-size: 0.7rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: #8b5cf6;
  margin-bottom: 2px;
}}
.compliance-id {{
  font-family: 'JetBrains Mono', monospace;
  font-weight: 600;
  color: #f1f5f9;
  font-size: 0.9rem;
}}
.compliance-title {{
  color: #cbd5e1;
  font-size: 0.82rem;
  margin: 4px 0 6px;
}}
.compliance-desc {{
  color: #64748b;
  font-size: 0.78rem;
  line-height: 1.5;
}}
.compliance-findings {{
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid rgba(148,163,184,0.06);
}}
.compliance-finding-tag {{
  display: inline-block;
  font-size: 0.7rem;
  padding: 2px 8px;
  border-radius: 4px;
  margin: 2px 4px 2px 0;
  background: rgba(148,163,184,0.08);
  color: #94a3b8;
}}

/* ── Recommendations ── */
.rec-list {{ list-style: none; counter-reset: rec-counter; }}
.rec-item {{
  counter-increment: rec-counter;
  display: flex;
  align-items: flex-start;
  gap: 16px;
  padding: 14px 0;
  border-bottom: 1px solid rgba(148,163,184,0.06);
}}
.rec-item:last-child {{ border-bottom: none; }}
.rec-number {{
  flex-shrink: 0;
  width: 32px; height: 32px;
  display: flex; align-items: center; justify-content: center;
  border-radius: 8px;
  font-family: 'JetBrains Mono', monospace;
  font-weight: 700;
  font-size: 0.8rem;
}}
.rec-text {{
  color: #cbd5e1;
  font-size: 0.88rem;
  line-height: 1.5;
}}
.rec-priority {{
  font-size: 0.7rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  margin-left: 8px;
  padding: 1px 8px;
  border-radius: 4px;
  vertical-align: middle;
}}

/* ── Footer ── */
.report-footer {{
  text-align: center;
  padding: 40px 32px 20px;
  color: #475569;
  font-size: 0.78rem;
}}
.report-footer .footer-brand {{
  font-size: 1rem;
  font-weight: 700;
  color: #64748b;
  letter-spacing: 0.08em;
  margin-bottom: 8px;
}}
.report-footer .footer-meta {{ margin-top: 4px; }}
.report-footer a {{
  color: #38bdf8;
  text-decoration: none;
}}
.report-footer a:hover {{ text-decoration: underline; }}
.footer-divider {{
  width: 60px;
  height: 2px;
  background: rgba(148,163,184,0.15);
  margin: 20px auto;
  border-radius: 2px;
}}

/* ── Print styles ── */
@media print {{
  body {{ background: #fff; color: #1e293b; }}
  body::before {{ display: none; }}
  .report-section {{ border: 1px solid #e2e8f0; background: #fff; }}
  .report-header {{ background: #f8fafc; }}
  .report-header::before {{ background: {risk_color}; }}
  .agent-table thead th {{ background: #f1f5f9; color: #475569; }}
  .agent-table tbody td {{ color: #334155; }}
  .finding-desc {{ color: #475569; }}
  .summary-card {{ background: #f8fafc; border-color: #e2e8f0; }}
  .summary-card .card-value {{ color: #0f172a; }}
}}

/* ── Responsive ── */
@media (max-width: 640px) {{
  .report-wrapper {{ padding: 20px 12px 40px; }}
  .report-section {{ padding: 20px 16px; }}
  .summary-grid {{ grid-template-columns: repeat(2, 1fr); }}
  .chart-container {{ flex-direction: column; }}
  .agent-table {{ font-size: 0.78rem; }}
  .agent-table thead th, .agent-table tbody td {{ padding: 8px 10px; }}
  .compliance-grid {{ grid-template-columns: 1fr; }}
}}
</style>
</head>
<body>
<div class="report-wrapper">
{body}
</div>
<script>
/* ── Sortable table ── */
document.addEventListener('DOMContentLoaded', function() {{
  const table = document.querySelector('.agent-table');
  if (!table) return;
  const headers = table.querySelectorAll('thead th');
  const tbody = table.querySelector('tbody');

  headers.forEach(function(th, idx) {{
    th.addEventListener('click', function() {{
      const rows = Array.from(tbody.querySelectorAll('tr'));
      const dir = th.dataset.dir === 'asc' ? 'desc' : 'asc';
      th.dataset.dir = dir;

      // Reset all arrows
      headers.forEach(function(h) {{
        const arrow = h.querySelector('.sort-arrow');
        if (arrow) arrow.textContent = '\\u2195';
      }});
      const arrow = th.querySelector('.sort-arrow');
      if (arrow) arrow.textContent = dir === 'asc' ? '\\u2191' : '\\u2193';

      rows.sort(function(a, b) {{
        const aText = a.children[idx] ? a.children[idx].textContent.trim().toLowerCase() : '';
        const bText = b.children[idx] ? b.children[idx].textContent.trim().toLowerCase() : '';
        if (dir === 'asc') return aText.localeCompare(bText);
        return bText.localeCompare(aText);
      }});

      rows.forEach(function(row) {{ tbody.appendChild(row); }});
    }});
  }});
}});
</script>
</body>
</html>"""


# ---------------------------------------------------------------------------
# Sections
# ---------------------------------------------------------------------------

def _section_header(
    result: ScanResult, risk: Severity, risk_color: str, timestamp: str,
) -> str:
    risk_label = risk.value.upper()
    badge_bg = _SEVERITY_BG[risk]
    return f"""
<header class="report-header">
  <div class="logo">
    <span class="logo-icon">&#9670;</span>
    <span class="logo-text">Eigent</span>
  </div>
  <div class="report-subtitle">Agent Security Report</div>
  <div class="header-meta">
    <span>Scan ID: <strong>{_esc(result.scan_id)}</strong></span>
    <span>{_esc(timestamp)}</span>
    <span>Duration: <strong>{result.scan_duration_seconds:.2f}s</strong></span>
  </div>
  <div class="risk-badge" style="color:{risk_color}; background:{badge_bg}; border-color:{risk_color};">
    Overall Risk: {risk_label}
  </div>
</header>"""


def _section_summary(result: ScanResult, shadow_count: int) -> str:
    no_auth = result.agents_no_auth
    no_auth_color = _SEVERITY_COLORS[Severity.CRITICAL] if no_auth > 0 else "#34d399"
    critical = result.critical_findings
    crit_color = _SEVERITY_COLORS[Severity.CRITICAL] if critical > 0 else "#34d399"

    return f"""
<section class="report-section">
  <h2 class="section-title">Executive Summary</h2>
  <div class="summary-grid">
    <div class="summary-card">
      <div class="card-value" style="color:#38bdf8">{result.total_agents}</div>
      <div class="card-label">Agents Discovered</div>
    </div>
    <div class="summary-card">
      <div class="card-value" style="color:{no_auth_color}">{no_auth}</div>
      <div class="card-label">No Authentication</div>
    </div>
    <div class="summary-card">
      <div class="card-value" style="color:{crit_color}">{critical}</div>
      <div class="card-label">Critical Findings</div>
    </div>
    <div class="summary-card">
      <div class="card-value" style="color:#8b5cf6">{shadow_count}</div>
      <div class="card-label">Shadow Agents</div>
    </div>
  </div>
</section>"""


def _section_risk_trend(diff: ScanDiff) -> str:
    added = len(diff.new_agents)
    removed = len(diff.removed_agents)
    net = added - removed
    if net > 0:
        agents_cls = "trend-up"
        agents_text = f"+{net} agents"
    elif net < 0:
        agents_cls = "trend-down"
        agents_text = f"{net} agents"
    else:
        agents_cls = "trend-neutral"
        agents_text = "no change"

    # Risk change (old, new) tuple — may be None
    risk_html = ""
    if diff.risk_change:
        prev_sev, curr_sev = diff.risk_change
        prev_color = _SEVERITY_COLORS[prev_sev]
        curr_color = _SEVERITY_COLORS[curr_sev]
        risk_html = (
            f'<div class="trend-item">'
            f'Risk: <strong style="color:{prev_color}">{prev_sev.value.upper()}</strong>'
            f" &rarr; "
            f'<strong style="color:{curr_color}">{curr_sev.value.upper()}</strong>'
            f"</div>"
        )

    new_f = len(diff.new_findings)
    resolved_f = len(diff.resolved_findings)

    return f"""
<section class="report-section">
  <h2 class="section-title">Risk Trend</h2>
  <div class="trend-box">
    <div class="trend-item">
      Since last scan:
    </div>
    <div class="trend-item">
      Agents: <strong class="{agents_cls}">{agents_text}</strong>
    </div>
    {risk_html}
    <div class="trend-item">
      New findings: <strong>{new_f}</strong>
      &nbsp;|&nbsp;
      Resolved: <strong class="trend-down">{resolved_f}</strong>
    </div>
  </div>
</section>"""


def _section_agents_table(result: ScanResult) -> str:
    headers = ["Name", "Source", "Transport", "Auth", "Command / URL", "Config"]
    ths = "".join(
        f'<th>{h} <span class="sort-arrow">&#8597;</span></th>' for h in headers
    )

    rows: list[str] = []
    for agent in result.agents:
        auth_text = agent.auth_status.value.replace("_", " ").upper()
        auth_color = _AUTH_COLORS.get(agent.auth_status, "#94a3b8")
        auth_bg = f"rgba({_hex_to_rgb(auth_color)},0.12)"

        if agent.command:
            cmd = _esc(agent.command)
            if agent.args:
                cmd += " " + _esc(" ".join(agent.args[:2]))
                if len(agent.args) > 2:
                    cmd += " ..."
        elif agent.url:
            cmd = _esc(agent.url)
        else:
            cmd = "&mdash;"

        config = _esc(agent.config_path) if agent.config_path else "&mdash;"

        rows.append(
            f"<tr>"
            f"<td>{_esc(agent.name)}</td>"
            f"<td>{_esc(agent.source.value)}</td>"
            f"<td>{_esc(agent.transport.value)}</td>"
            f'<td><span class="auth-badge" style="color:{auth_color};background:{auth_bg}">'
            f"{auth_text}</span></td>"
            f"<td>{cmd}</td>"
            f'<td><span class="config-path">{config}</span></td>'
            f"</tr>"
        )

    return f"""
<section class="report-section">
  <h2 class="section-title">Agent Inventory</h2>
  <div style="overflow-x:auto">
  <table class="agent-table">
    <thead><tr>{ths}</tr></thead>
    <tbody>{"".join(rows)}</tbody>
  </table>
  </div>
</section>"""


def _section_findings(result: ScanResult) -> str:
    severity_order = [Severity.CRITICAL, Severity.HIGH, Severity.MEDIUM, Severity.LOW, Severity.INFO]
    sorted_findings = sorted(result.findings, key=lambda f: severity_order.index(f.severity))

    cards: list[str] = []
    for finding in sorted_findings:
        color = _SEVERITY_COLORS[finding.severity]
        bg = _SEVERITY_BG[finding.severity]
        sev_bg = f"rgba({_hex_to_rgb(color)},0.15)"
        cards.append(
            f'<div class="finding-card" style="border-color:{color}; background:{bg}">'
            f'<div class="finding-header">'
            f'<span class="finding-severity" style="color:{color}; background:{sev_bg}">'
            f"{_esc(finding.severity.value.upper())}</span>"
            f'<span class="finding-title">{_esc(finding.title)}</span>'
            f"</div>"
            f'<div class="finding-agent">{_esc(finding.agent_name)}</div>'
            f'<div class="finding-desc">{_esc(finding.description)}</div>'
            f'<div class="finding-rec">{_esc(finding.recommendation)}</div>'
            f"</div>"
        )

    return f"""
<section class="report-section">
  <h2 class="section-title">Security Findings</h2>
  {"".join(cards)}
</section>"""


def _section_compliance(result: ScanResult) -> str:
    # Collect unique compliance tags and map them to findings
    tag_findings: dict[tuple[str, str], tuple[ComplianceTag, list[str]]] = {}

    for finding in result.findings:
        tags = get_compliance_tags(finding)
        for tag in tags:
            key = (tag.framework, tag.control_id)
            if key not in tag_findings:
                tag_findings[key] = (tag, [])
            if finding.title not in tag_findings[key][1]:
                tag_findings[key][1].append(finding.title)

    if not tag_findings:
        return ""

    cards: list[str] = []
    for (framework, control_id), (tag, finding_titles) in sorted(tag_findings.items()):
        finding_tags_html = "".join(
            f'<span class="compliance-finding-tag">{_esc(t)}</span>' for t in finding_titles
        )
        cards.append(
            f'<div class="compliance-card">'
            f'<div class="compliance-framework">{_esc(framework)}</div>'
            f'<div class="compliance-id">{_esc(control_id)} &mdash; {_esc(tag.title)}</div>'
            f'<div class="compliance-desc">{_esc(tag.description)}</div>'
            f'<div class="compliance-findings">{finding_tags_html}</div>'
            f"</div>"
        )

    return f"""
<section class="report-section">
  <h2 class="section-title">Compliance Mapping</h2>
  <div class="compliance-grid">{"".join(cards)}</div>
</section>"""


def _section_recommendations(result: ScanResult) -> str:
    if not result.findings:
        return ""

    severity_order = [Severity.CRITICAL, Severity.HIGH, Severity.MEDIUM, Severity.LOW, Severity.INFO]
    seen: dict[str, Severity] = {}
    recs: list[tuple[Severity, str]] = []

    for finding in sorted(result.findings, key=lambda f: severity_order.index(f.severity)):
        rec = finding.recommendation
        if rec not in seen:
            seen[rec] = finding.severity
            recs.append((finding.severity, rec))

    items: list[str] = []
    for i, (severity, rec) in enumerate(recs[:10], 1):
        color = _SEVERITY_COLORS[severity]
        bg = f"rgba({_hex_to_rgb(color)},0.12)"
        items.append(
            f'<li class="rec-item">'
            f'<span class="rec-number" style="color:{color}; background:{bg}">{i}</span>'
            f'<span class="rec-text">{_esc(rec)}'
            f'<span class="rec-priority" style="color:{color}; background:{bg}">'
            f"{_esc(severity.value.upper())}</span></span>"
            f"</li>"
        )

    return f"""
<section class="report-section">
  <h2 class="section-title">Prioritized Recommendations</h2>
  <ol class="rec-list">{"".join(items)}</ol>
</section>"""


def _section_footer(result: ScanResult) -> str:
    return f"""
<footer class="report-footer">
  <div class="footer-divider"></div>
  <div class="footer-brand">&#9670; Eigent</div>
  <div class="footer-meta">
    Scan ID: {_esc(result.scan_id)} &nbsp;&bull;&nbsp;
    Scanner v{_esc(result.scanner_version)} &nbsp;&bull;&nbsp;
    <a href="https://eigent.dev">eigent.dev</a>
  </div>
  <div class="footer-meta" style="margin-top:8px">
    Discover AI agents. Expose security gaps. Enforce trust.
  </div>
</footer>"""


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _hex_to_rgb(hex_color: str) -> str:
    """Convert #rrggbb to 'r,g,b' string for use in rgba()."""
    h = hex_color.lstrip("#")
    return f"{int(h[0:2], 16)},{int(h[2:4], 16)},{int(h[4:6], 16)}"
