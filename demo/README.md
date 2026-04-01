# Eigent Demo -- OAuth for AI Agents

End-to-end demonstration of the Eigent IAM flow in 90 seconds.

## What it shows

1. **Human authentication** -- Alice logs in via SSO, binding her identity
2. **Agent token issuance** -- code-reviewer agent gets a scoped token (read_file, run_tests, write_file)
3. **Delegation with narrowing** -- code-reviewer delegates to test-runner with only run_tests
4. **Delegation chain** -- Cryptographic chain from test-runner back to alice@acme.com
5. **Permission enforcement** -- Sidecar blocks unauthorized tool calls in real time
6. **MCP tool call interception** -- test-runner can run tests but cannot read or delete files
7. **Audit trail** -- Every action logged with the authorizing human
8. **Cascade revocation** -- Revoking code-reviewer instantly revokes test-runner too

## Prerequisites

- Node.js >= 20
- npm

## Quick Start

```bash
# From the repo root:
bash demo/run-demo.sh
```

That's it. The script installs dependencies automatically and runs the full demo.

## Files

| File | Purpose |
|------|---------|
| `run-demo.sh` | Shell wrapper that installs deps and runs the demo |
| `eigent-demo.ts` | Self-contained TypeScript demo engine (uses jose for real JWT ops) |
| `mock-mcp-server.ts` | Mock MCP server over stdio with read_file, write_file, delete_file tools |
| `demo-video-script.md` | 90-second video recording script for Twitter/HN/pitch |
| `package.json` | Demo dependencies (jose, uuid, tsx) |

## How it works

The demo is self-contained. It does **not** require the full eigent-registry server to be running. Instead, `eigent-demo.ts` implements an in-memory registry that:

- Generates real ES256 signing keys (same algorithm as production)
- Issues real JWTs with eigent+jwt token type
- Manages agent records with parent/child relationships
- Enforces scope intersection on delegation
- Performs cascade revocation across the delegation tree
- Maintains a full audit log

This matches the real Eigent architecture (see `eigent-registry/`, `eigent-core/`, `eigent-sidecar/`) but runs entirely in-process for demo reliability.

## Mock MCP Server

`mock-mcp-server.ts` implements the MCP protocol over stdio:

- Responds to `initialize`, `tools/list`, and `tools/call`
- Has three tools: read_file, write_file, delete_file
- Uses a mock in-memory filesystem
- Can be used standalone for testing the eigent-sidecar:

```bash
# Run the mock MCP server directly:
npx tsx mock-mcp-server.ts

# Use with eigent-sidecar:
eigent-sidecar -- npx tsx mock-mcp-server.ts
```

## Recording the Video

See `demo-video-script.md` for the full recording guide. Quick version:

```bash
# With asciinema:
asciinema rec demo.cast -c "bash demo/run-demo.sh"

# Convert to GIF:
agg demo.cast demo.gif
```

## Architecture Reference

```
Human (alice@acme.com)
  |
  | SSO login (OIDC)
  v
Eigent Registry
  |
  | issues eigent+jwt token
  v
code-reviewer agent  [read_file, run_tests, write_file]
  |
  | delegation (scope narrowing)
  v
test-runner agent    [run_tests only]
  |
  | tools/call via MCP
  v
Eigent Sidecar  <-- enforces scope, logs audit trail
  |
  v
MCP Server (filesystem, database, etc.)
```
