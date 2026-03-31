# Eigent

**The fundamental trust state of autonomous AI agents.**

*eigen* (fundamental, intrinsic) + *agent* = **eigent** — the irreducible identity, trust level, and alignment state of an AI agent.

---

## What is Eigent?

In a world where AI agents outnumber humans 144:1 in the enterprise, **Eigent** is the trust infrastructure that makes autonomous AI accountable.

We don't build another proxy. We build the **intelligence layer** that sits above the 163+ existing MCP proxies — providing identity, observability, compliance, and behavioral intelligence for every AI agent in your organization.

### The Problem

- **95%** of enterprises run AI agents autonomously
- **88%** had a confirmed agent security incident last year
- **82%** of executives think they're protected — only **21%** have actual visibility
- Shadow AI breaches cost **$670K more** than standard incidents

### What Eigent Does

| Layer | What | Status |
|-------|------|--------|
| **Eigent Scan** | Open-source agent scanner — discovers MCP servers, flags risks | Working |
| **Eigent Sidecar** | Lightweight MCP traffic interceptor, exports OpenTelemetry spans | Working |
| **Eigent Platform** | Identity registry, audit store, compliance reports, cost attribution | Building |
| **Eigent Intelligence** | Cross-customer behavioral analysis, agent risk scoring | Planned |

### Architecture

```
AI Agent → MCP Client → [Eigent Sidecar] → MCP Server → Tool/Resource
                              ↓
                    Eigent Platform
                    ├── Identity Registry
                    ├── Audit Store
                    ├── Compliance Reports (EU AI Act, SOC2)
                    ├── Cost Attribution
                    └── Risk Scoring
```

## Quick Start

### Scanner (find what's running)

```bash
pip install eigent-scan
eigent-scan scan --verbose
```

### Sidecar (capture telemetry)

```bash
# Instead of:
npx @modelcontextprotocol/server-filesystem /tmp

# Use:
eigent-sidecar wrap -- npx @modelcontextprotocol/server-filesystem /tmp
```

## Project Structure

```
eigent-scan/          # Python CLI scanner (working)
eigent-sidecar/       # TypeScript MCP sidecar (working)
otel-mcp-convention/  # OpenTelemetry semantic convention for MCP (draft)
research/             # Market research, competitive analysis, technical architecture
recruiting/           # Co-founder recruiting package
```

## Market

- **$38.8B** NHI Access Management market by 2036
- **$5.75B** AI Governance market by 2034
- **91%** of organizations increased IAM spending in 2026
- EU AI Act enforcement begins August 2027

## License

Apache 2.0
