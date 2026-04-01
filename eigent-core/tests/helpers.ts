import type { EigentTokenClaims } from '../src/types.js';

/**
 * Build a valid set of token claims for testing.
 * Override any field by passing partial claims.
 */
export function buildTestClaims(overrides?: Partial<EigentTokenClaims>): EigentTokenClaims {
  return {
    sub: 'spiffe://acme.corp/agent/test-agent-001',
    iss: 'https://registry.eigent.dev',
    aud: 'https://mcp.acme.corp/tools',
    human: {
      sub: 'user-12345',
      email: 'alice@acme.corp',
      iss: 'https://login.acme.corp',
      groups: ['engineering', 'ml-team'],
    },
    agent: {
      name: 'code-review-bot',
      model: 'claude-sonnet-4-20250514',
      framework: 'MCP',
    },
    scope: ['read_file', 'run_tests', 'write_file'],
    delegation: {
      depth: 0,
      max_depth: 3,
      chain: [],
      can_delegate: ['read_file', 'run_tests'],
    },
    ...overrides,
  };
}
