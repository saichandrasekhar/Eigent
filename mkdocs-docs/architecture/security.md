# Security Model

This document describes Eigent's threat model, cryptographic choices, and failure modes. It is intended for security engineers, auditors, and anyone evaluating Eigent's security properties.

## Threat Model

### What Eigent Protects Against

| Threat | Mitigation |
|--------|------------|
| **Agent impersonation** | Ed25519-signed tokens with unique agent identifiers |
| **Privilege escalation** | Three-way scope intersection; permissions can only narrow |
| **Orphaned agents** | Human binding in every token; cascade revocation |
| **Unauthorized tool access** | Sidecar enforcement with per-call verification |
| **Audit evasion** | All verification decisions logged to audit trail |
| **Token replay** | Short-lived tokens (default 1 hour) with UUIDv7 JTI |
| **Delegation depth abuse** | max_depth limit enforced at issuance and delegation |
| **Circular delegation** | Chain validation rejects tokens with circular references |

### What Eigent Does Not Protect Against

| Threat | Why | Mitigation |
|--------|-----|------------|
| **Compromised registry** | Registry holds signing keys | Deploy in hardened environment; use HSM in production |
| **Compromised sidecar host** | Sidecar runs on the same host as the agent | Use container isolation; verify sidecar integrity |
| **Tool-level vulnerabilities** | Eigent controls access, not tool behavior | Combine with tool-level security (sandboxing, WAF) |
| **LLM prompt injection** | Eigent operates at the tool call level, not prompt level | Use prompt injection defenses separately |
| **Network-level MITM** | Registry API over HTTP in development | Use TLS in production |

## Cryptographic Choices

### Ed25519 (EdDSA)

Eigent uses Ed25519 for all token signatures. This is specified as `EdDSA` in the JWS header per RFC 8037.

**Why Ed25519:**

| Property | Value |
|----------|-------|
| Security level | 128-bit (equivalent to RSA-3072) |
| Signature size | 64 bytes |
| Public key size | 32 bytes |
| Signature time | ~20 microseconds |
| Verification time | ~60 microseconds |
| Deterministic | Yes (no nonce required) |
| Side-channel resistant | Yes (constant-time operations) |

**Why not RSA?** RSA-2048 signatures are 256 bytes (4x larger) and slower to compute. RSA-2048 also provides only ~112-bit security.

**Why not ECDSA?** ECDSA requires a high-quality random nonce for each signature. A weak or repeated nonce leaks the private key (as happened in the Sony PS3 hack). Ed25519 is deterministic, eliminating this entire class of vulnerability.

**Why not ES256 (P-256)?** P-256 is acceptable but Ed25519 is faster, produces smaller signatures, and has a simpler implementation with fewer footguns.

### JWS (RFC 7515)

Tokens use the JWS Compact Serialization format. The `jose` library handles all JWS operations and is one of the most widely used and audited JWT libraries in the Node.js ecosystem.

**Token structure:**

```
BASE64URL(header) . BASE64URL(payload) . BASE64URL(signature)
```

**Header:**

```json
{
  "alg": "EdDSA",
  "typ": "eigent+jwt",
  "kid": "<sha256-thumbprint>"
}
```

The `typ: eigent+jwt` distinguishes Eigent tokens from standard JWTs, preventing confusion between different token types in environments that use multiple JWT issuers.

### UUIDv7

Token identifiers (`jti`) and agent identifiers use UUIDv7, which embeds a millisecond-precision timestamp in the first 48 bits. This provides:

- Natural time ordering (sorted IDs = sorted by creation time)
- Uniqueness without coordination
- Tamper-evident ordering (inserting a backdated event requires guessing the correct timestamp prefix)

### Key ID (`kid`)

The `kid` header contains the SHA-256 thumbprint of the signing public key, computed per RFC 7638 (JWK Thumbprint). This allows:

- Key rotation (multiple keys can coexist)
- Key identification without transmitting the full public key
- JWKS lookup for offline verification

## Token Security Properties

### Integrity

The Ed25519 signature covers the entire header and payload. Any modification to any field (scope, delegation, human binding, expiry) invalidates the signature.

### Authenticity

Only the registry's private key can produce valid signatures. Verifiers use the registry's public key (via JWKS endpoint) to confirm authenticity.

### Non-repudiation

The `human` claim binds every token to a specific human identity. Combined with the audit trail, this provides non-repudiation: the system can prove that Alice authorized agent X to perform action Y at time Z.

### Temporal Validity

Tokens include both `iat` (issued at) and `exp` (expiration) claims. The default TTL is 1 hour. Verification rejects expired tokens regardless of signature validity.

### Scope Immutability

Once a token is issued, its scope cannot be modified without re-issuance. The scope is part of the signed payload, so any change invalidates the signature.

## Failure Modes

### Registry Unavailable

**Impact:** New tokens cannot be issued. Sidecar cannot verify tokens via the registry API.

**Mitigation:**

- Tokens can be verified offline using the JWKS public key (signature and expiry checks)
- Scope checks can be performed locally by decoding the token payload
- The sidecar should cache the JWKS and fall back to offline verification

!!! warning "Offline verification limitations"
    Offline verification cannot check revocation status. If the registry is down, revoked tokens may still pass offline verification. This is an acceptable tradeoff for availability, as tokens are short-lived by default.

### Sidecar Crash

**Impact:** MCP traffic is no longer intercepted. Tool calls go directly to the MCP server.

**Mitigation:**

- The sidecar is a child process of the MCP server command. If the sidecar crashes, the MCP server also stops.
- Process supervision (systemd, Docker restart policies) should restart the sidecar.
- Monitor sidecar health via OTel heartbeat spans.

### Private Key Compromise

**Impact:** An attacker with the registry's private key can forge arbitrary tokens.

**Mitigation:**

1. Detect: Monitor for tokens not matching any registry-issued agent record
2. Respond: Rotate the registry key pair immediately
3. Recover: Re-issue all active tokens with the new key
4. Prevent: Use HSM or KMS for key storage in production

### Token Theft

**Impact:** An attacker with a stolen token can make tool calls as the agent until the token expires.

**Mitigation:**

1. Short TTLs (default 1 hour) limit the window of exposure
2. `eigent revoke` immediately invalidates the token
3. Audit trail shows all tool calls made with the token
4. Token files should have restrictive permissions (`chmod 600`)

### Clock Skew

**Impact:** Nodes with significant clock drift may accept expired tokens or reject valid ones.

**Mitigation:**

- Use NTP to keep clocks synchronized across all nodes
- The `jose` library allows configurable clock tolerance
- Short TTLs minimize the impact of minor clock skew

## Security Checklist

For production deployments:

- [ ] Run the registry behind TLS (HTTPS)
- [ ] Store registry private keys in an HSM or KMS
- [ ] Set restrictive file permissions on token files (`chmod 600`)
- [ ] Enable sidecar enforcement mode (not monitor)
- [ ] Configure short TTLs appropriate for your workflow
- [ ] Set up SIEM alerting for blocked tool calls
- [ ] Implement regular key rotation
- [ ] Enable audit log export to immutable storage
- [ ] Run `eigent-scan` in CI/CD to detect unprotected agents
- [ ] Restrict registry API access to authorized networks
- [ ] Monitor for anomalous token issuance patterns
- [ ] Document incident response procedures for token compromise

## Security Contacts

Report security vulnerabilities to: **security@eigent.dev**

We follow responsible disclosure practices. Please do not open public GitHub issues for security vulnerabilities.
