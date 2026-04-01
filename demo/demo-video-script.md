# Eigent Demo Video Script (90 seconds)

**Target platforms:** Twitter/X, Hacker News, investor pitch decks
**Format:** Terminal recording (asciinema or Screen Studio)
**Resolution:** 1920x1080, dark terminal theme (Dracula or One Dark)

---

## Pre-recording Setup

1. Clean terminal, large font (18-20pt)
2. Run `bash demo/run-demo.sh` once to warm up (installs deps)
3. Clear terminal, start recording

---

## Script

### 0:00-0:05 -- Hook (5s)

**On screen:** Title card or terminal banner appears

```
============================================================
  EIGENT DEMO: OAuth for AI Agents
============================================================
```

**Say:** "AI agents are using your credentials with zero accountability. Eigent fixes that."

**Key message:** Grab attention with the problem.

---

### 0:05-0:15 -- Human Authentication (10s)

**On screen:** Steps 1-2 appear (registry init + human login)

```
[Step 1/10] Initializing Eigent registry...
  [OK] Registry initialized with ES256 signing key

[Step 2/10] Authenticating human: alice@acme.com
  [OK] Human identity verified: alice@acme.com
```

**Say:** "Alice logs in through her normal SSO. Eigent binds her identity to everything that follows."

**Key message:** Starts with humans, not agents. Every agent traces back to a person.

---

### 0:15-0:30 -- Token Issuance + Delegation (15s)

**On screen:** Steps 3-4 appear (issue token + delegate)

```
[Step 3/10] Issuing eigent token for "code-reviewer" agent...
  [OK] Token issued for code-reviewer
  Scope:      [read_file, run_tests, write_file]
  Can delegate: [read_file, run_tests]

[Step 4/10] Delegating to "test-runner" (narrowed to run_tests only)...
  [OK] Delegation issued: code-reviewer -> test-runner
  Scope:      [run_tests]  (narrowed from parent's 3 scopes)
```

**Say:** "Alice gives code-reviewer three permissions. Code-reviewer delegates to test-runner -- but only run_tests. Permissions can only narrow, never expand."

**Key message:** Least privilege by design. Delegation always narrows scope.

---

### 0:30-0:40 -- Delegation Chain (10s)

**On screen:** Step 5 -- the visual chain

```
  alice@acme.com (human)
    |
    +-- code-reviewer  [read_file, run_tests, write_file]  depth=0
          |
          +-- test-runner  [run_tests]  depth=1
```

**Say:** "The full chain is cryptographically verifiable. You always know who authorized what."

**Key message:** Transparency and traceability.

---

### 0:40-0:55 -- Permission Enforcement (15s)

**On screen:** Steps 6-7 -- permission checks and MCP enforcement

```
  [ALLOWED] test-runner -> run_tests
  [DENIED]  test-runner -> read_file
  [DENIED]  test-runner -> delete_file
  [ALLOWED] code-reviewer -> write_file
  [DENIED]  code-reviewer -> delete_file

  [ALLOWED] test-runner calls run_tests -> All 42 tests passed
  [DENIED]  test-runner calls read_file -> BLOCKED by sidecar
  [ALLOWED] code-reviewer calls write_file -> Wrote 4 bytes
```

**Say:** "The sidecar sits between the agent and the MCP server. Test-runner can run tests -- but it cannot read files or delete anything. Every call is checked against the token's scope."

**Key message:** Real enforcement at the tool call layer, not just policy documents.

---

### 0:55-1:10 -- Audit Trail (15s)

**On screen:** Step 8 -- audit log entries

```
  HH:MM:SS  token_issued          code-reviewer    [success]
  HH:MM:SS  delegation_issued     test-runner      [success]
  HH:MM:SS  permission_check      test-runner      tool=run_tests   [allowed]
  HH:MM:SS  tool_call_blocked     test-runner      tool=read_file   [denied]
  HH:MM:SS  tool_call             code-reviewer    tool=write_file  [executed]
```

**Say:** "Every token issuance, every delegation, every tool call, every denial -- all logged with the human who authorized it."

**Key message:** Complete audit trail for compliance and forensics.

---

### 1:10-1:25 -- Cascade Revocation (15s)

**On screen:** Steps 9-10 -- revoke and verify

```
[Step 9/10] Revoking code-reviewer (cascade)...
  [OK] Revoked: code-reviewer
  [OK] Cascade revoked: test-runner

[Step 10/10] Post-revocation checks:
  [DENIED] code-reviewer -> read_file (token revoked)
  [DENIED] test-runner -> run_tests (cascade revoked)
```

**Say:** "Revoke one agent and the entire delegation tree goes down instantly. No orphaned tokens. No zombie agents."

**Key message:** Instant, complete revocation. One command kills the whole chain.

---

### 1:25-1:30 -- Summary + CTA (5s)

**On screen:** Demo complete summary

```
  [PASS] Permission narrowing
  [PASS] Scope enforcement
  [PASS] Cascade revocation
  [PASS] Audit trail
  [PASS] Human binding
```

**Say:** "Eigent: OAuth for AI Agents. Open source, works with any MCP server, drops into your existing stack."

**Key message:** Open source, standards-based, production-ready.

---

## Post-production Notes

- Speed up the pauses between steps to keep it tight
- Add subtle sound effects on ALLOWED/DENIED for emphasis
- Consider adding a lower-third with the GitHub URL
- For Twitter: trim to 60 seconds by cutting audit trail details
- For investor pitch: keep full 90 seconds, add slide at end with architecture diagram
- For HN: post as Show HN with the raw terminal output as the thumbnail

## Recording Commands

```bash
# Option 1: asciinema (terminal recording)
asciinema rec demo.cast -c "bash demo/run-demo.sh"
# Convert to GIF: agg demo.cast demo.gif

# Option 2: Screen Studio / OBS (video)
# Set up 1920x1080, start recording, then:
bash demo/run-demo.sh
```

## Suggested Titles

- Twitter: "We built OAuth for AI Agents. Here's the full flow in 90 seconds."
- HN: "Show HN: Eigent -- OAuth-style identity and delegation for AI agents"
- Pitch: "Eigent: The Identity Layer for the Agent Economy"
