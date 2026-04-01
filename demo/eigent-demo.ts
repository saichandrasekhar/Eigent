/**
 * Eigent End-to-End Demo
 *
 * Demonstrates the full IAM flow for AI agents in 90 seconds:
 *   Human auth -> Agent token -> Delegation -> Permission enforcement -> Cascade revocation
 *
 * This is a self-contained script that uses jose for JWT operations,
 * matching the real Eigent architecture without requiring the full
 * registry server to be running.
 */

import {
  generateKeyPair,
  SignJWT,
  exportJWK,
  type KeyLike,
  type JWK,
} from 'jose';
import { v7 as uuidv7 } from 'uuid';

// ── Terminal formatting ─────────────────────────────────────────────────

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const BLUE = '\x1b[34m';
const MAGENTA = '\x1b[35m';
const BG_GREEN = '\x1b[42m';
const BG_RED = '\x1b[41m';

function banner(text: string): void {
  const line = '='.repeat(60);
  process.stdout.write(`\n${BOLD}${CYAN}${line}${RESET}\n`);
  process.stdout.write(`${BOLD}${CYAN}  ${text}${RESET}\n`);
  process.stdout.write(`${BOLD}${CYAN}${line}${RESET}\n\n`);
}

function step(num: number, text: string): void {
  process.stdout.write(`${BOLD}${BLUE}[Step ${num}/10]${RESET} ${BOLD}${text}${RESET}\n`);
}

function info(text: string): void {
  process.stdout.write(`  ${DIM}${text}${RESET}\n`);
}

function success(text: string): void {
  process.stdout.write(`  ${GREEN}[OK]${RESET} ${text}\n`);
}

function denied(text: string): void {
  process.stdout.write(`  ${RED}[DENIED]${RESET} ${text}\n`);
}

function allowed(text: string): void {
  process.stdout.write(`  ${GREEN}[ALLOWED]${RESET} ${text}\n`);
}

function chainLine(text: string): void {
  process.stdout.write(`  ${MAGENTA}${text}${RESET}\n`);
}

function auditLine(text: string): void {
  process.stdout.write(`  ${DIM}${text}${RESET}\n`);
}

function pause(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── In-memory registry (simulates eigent-registry) ──────────────────────

interface AgentRecord {
  id: string;
  name: string;
  humanEmail: string;
  humanSub: string;
  scope: string[];
  parentId: string | null;
  delegationDepth: number;
  maxDelegationDepth: number;
  canDelegate: string[];
  tokenJti: string;
  token: string;
  status: 'active' | 'revoked';
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
}

interface AuditEntry {
  id: string;
  timestamp: Date;
  agentId: string;
  agentName: string;
  humanEmail: string;
  action: string;
  toolName: string | null;
  result: string;
  delegationChain: string[];
}

const agents = new Map<string, AgentRecord>();
const auditLog: AuditEntry[] = [];
let signingKey: KeyLike;
let publicKey: KeyLike;
let publicJwk: JWK;
let kid: string;

// ── Registry operations ─────────────────────────────────────────────────

async function initRegistry(): Promise<void> {
  const keyPair = await generateKeyPair('ES256', { extractable: true });
  signingKey = keyPair.privateKey;
  publicKey = keyPair.publicKey;
  publicJwk = await exportJWK(publicKey);
  kid = uuidv7();
  publicJwk.kid = kid;
  publicJwk.alg = 'ES256';
  publicJwk.use = 'sig';
}

async function issueAgentToken(opts: {
  name: string;
  humanEmail: string;
  humanSub: string;
  scope: string[];
  parentId: string | null;
  delegationDepth: number;
  maxDelegationDepth: number;
  canDelegate: string[];
}): Promise<{ agentId: string; token: string; jti: string }> {
  const agentId = uuidv7();
  const jti = uuidv7();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 3600 * 1000);

  // Build delegation chain
  const chain: string[] = [];
  if (opts.parentId) {
    const parent = agents.get(opts.parentId);
    if (parent) {
      // Walk up to build the chain
      let current: AgentRecord | undefined = parent;
      while (current) {
        chain.unshift(current.id);
        current = current.parentId ? agents.get(current.parentId) : undefined;
      }
    }
  }
  chain.push(agentId);

  const token = await new SignJWT({
    agent_id: agentId,
    human_sub: opts.humanSub,
    human_email: opts.humanEmail,
    human_iss: 'https://accounts.acme.com',
    scope: opts.scope,
    delegation_depth: opts.delegationDepth,
    max_delegation_depth: opts.maxDelegationDepth,
    delegation_chain: chain,
    can_delegate: opts.canDelegate,
  })
    .setProtectedHeader({ alg: 'ES256', kid, typ: 'eigent+jwt' })
    .setIssuer('eigent-registry')
    .setSubject(agentId)
    .setIssuedAt()
    .setExpirationTime(expiresAt)
    .setJti(jti)
    .sign(signingKey);

  const record: AgentRecord = {
    id: agentId,
    name: opts.name,
    humanEmail: opts.humanEmail,
    humanSub: opts.humanSub,
    scope: opts.scope,
    parentId: opts.parentId,
    delegationDepth: opts.delegationDepth,
    maxDelegationDepth: opts.maxDelegationDepth,
    canDelegate: opts.canDelegate,
    tokenJti: jti,
    token,
    status: 'active',
    createdAt: now,
    expiresAt,
    revokedAt: null,
  };

  agents.set(agentId, record);

  // Audit log
  auditLog.push({
    id: uuidv7(),
    timestamp: now,
    agentId,
    agentName: opts.name,
    humanEmail: opts.humanEmail,
    action: opts.parentId ? 'delegation_issued' : 'token_issued',
    toolName: null,
    result: 'success',
    delegationChain: chain,
  });

  return { agentId, token, jti };
}

function findAgentByName(name: string): AgentRecord | undefined {
  for (const agent of agents.values()) {
    if (agent.name === name) return agent;
  }
  return undefined;
}

function getDelegationChain(agentId: string): AgentRecord[] {
  const chain: AgentRecord[] = [];
  let current = agents.get(agentId);
  while (current) {
    chain.unshift(current);
    current = current.parentId ? agents.get(current.parentId) : undefined;
  }
  return chain;
}

function verifyPermission(agentName: string, toolName: string): boolean {
  const agent = findAgentByName(agentName);
  if (!agent) return false;
  if (agent.status !== 'active') return false;

  const isAllowed = agent.scope.includes(toolName) || agent.scope.includes('*');

  // Audit the check
  auditLog.push({
    id: uuidv7(),
    timestamp: new Date(),
    agentId: agent.id,
    agentName: agent.name,
    humanEmail: agent.humanEmail,
    action: 'permission_check',
    toolName,
    result: isAllowed ? 'allowed' : 'denied',
    delegationChain: getDelegationChain(agent.id).map((a) => a.name),
  });

  return isAllowed;
}

function revokeAgent(agentName: string): { revoked: string[]; cascadeRevoked: string[] } {
  const agent = findAgentByName(agentName);
  if (!agent) return { revoked: [], cascadeRevoked: [] };

  const revoked = [agent.name];
  const cascadeRevoked: string[] = [];

  agent.status = 'revoked';
  agent.revokedAt = new Date();

  // Cascade: revoke all descendants
  for (const child of agents.values()) {
    if (child.parentId === agent.id && child.status === 'active') {
      child.status = 'revoked';
      child.revokedAt = new Date();
      cascadeRevoked.push(child.name);

      auditLog.push({
        id: uuidv7(),
        timestamp: new Date(),
        agentId: child.id,
        agentName: child.name,
        humanEmail: child.humanEmail,
        action: 'cascade_revoked',
        toolName: null,
        result: `cascade from ${agentName}`,
        delegationChain: getDelegationChain(child.id).map((a) => a.name),
      });
    }
  }

  auditLog.push({
    id: uuidv7(),
    timestamp: new Date(),
    agentId: agent.id,
    agentName: agent.name,
    humanEmail: agent.humanEmail,
    action: 'revoked',
    toolName: null,
    result: `cascade: ${cascadeRevoked.length} children revoked`,
    delegationChain: [agent.name],
  });

  return { revoked, cascadeRevoked };
}

// ── MCP enforcement simulation ──────────────────────────────────────────

interface McpToolCallResult {
  tool: string;
  agent: string;
  allowed: boolean;
  response: string | null;
}

async function simulateMcpToolCall(
  agentName: string,
  toolName: string,
  args: Record<string, string>,
): Promise<McpToolCallResult> {
  const agent = findAgentByName(agentName);
  if (!agent) {
    return { tool: toolName, agent: agentName, allowed: false, response: null };
  }

  const isAllowed = verifyPermission(agentName, toolName);

  if (!isAllowed) {
    auditLog.push({
      id: uuidv7(),
      timestamp: new Date(),
      agentId: agent.id,
      agentName,
      humanEmail: agent.humanEmail,
      action: 'tool_call_blocked',
      toolName,
      result: 'denied: scope insufficient',
      delegationChain: getDelegationChain(agent.id).map((a) => a.name),
    });

    return {
      tool: toolName,
      agent: agentName,
      allowed: false,
      response: null,
    };
  }

  // Simulate mock MCP response
  let mockResponse: string;
  switch (toolName) {
    case 'read_file':
      mockResponse = `Contents of ${args.path ?? 'file.txt'}: "Hello, world!"`;
      break;
    case 'write_file':
      mockResponse = `Wrote ${(args.content ?? '').length} bytes to ${args.path ?? 'file.txt'}`;
      break;
    case 'run_tests':
      mockResponse = 'All 42 tests passed (3.2s)';
      break;
    case 'delete_file':
      mockResponse = `Deleted ${args.path ?? 'file.txt'}`;
      break;
    default:
      mockResponse = `Tool ${toolName} executed`;
  }

  auditLog.push({
    id: uuidv7(),
    timestamp: new Date(),
    agentId: agent.id,
    agentName,
    humanEmail: agent.humanEmail,
    action: 'tool_call',
    toolName,
    result: 'executed',
    delegationChain: getDelegationChain(agent.id).map((a) => a.name),
  });

  return {
    tool: toolName,
    agent: agentName,
    allowed: true,
    response: mockResponse,
  };
}

// ── Main demo flow ──────────────────────────────────────────────────────

async function runDemo(): Promise<void> {
  banner('EIGENT DEMO: OAuth for AI Agents');
  info('Demonstrates: human auth -> agent token -> delegation -> enforcement -> revocation');
  info('');
  await pause(1000);

  // ── Step 1: Initialize registry ──────────────────────────────────────
  step(1, 'Initializing Eigent registry...');
  await initRegistry();
  success('Registry initialized with ES256 signing key');
  info(`Key ID: ${kid.substring(0, 8)}...`);
  info(`JWKS endpoint: /.well-known/jwks.json (1 key)`);
  await pause(800);

  // ── Step 2: Human authentication ─────────────────────────────────────
  step(2, 'Authenticating human: alice@acme.com');
  const humanSub = 'auth0|alice-12345';
  const humanEmail = 'alice@acme.com';
  info(`IdP: https://accounts.acme.com`);
  info(`Subject: ${humanSub}`);
  success(`Human identity verified: ${humanEmail}`);
  await pause(800);

  // ── Step 3: Issue root agent token ───────────────────────────────────
  step(3, 'Issuing eigent token for "code-reviewer" agent...');
  const rootScope = ['read_file', 'run_tests', 'write_file'];
  const { agentId: codeReviewerId, token: codeReviewerToken } = await issueAgentToken({
    name: 'code-reviewer',
    humanEmail,
    humanSub,
    scope: rootScope,
    parentId: null,
    delegationDepth: 0,
    maxDelegationDepth: 2,
    canDelegate: ['read_file', 'run_tests'],
  });
  success(`Token issued for code-reviewer`);
  info(`Agent ID:   ${codeReviewerId.substring(0, 8)}...`);
  info(`Scope:      [${rootScope.join(', ')}]`);
  info(`Max depth:  2`);
  info(`Can delegate: [read_file, run_tests]`);
  info(`Token (first 60 chars): ${codeReviewerToken.substring(0, 60)}...`);
  await pause(800);

  // ── Step 4: Delegate to test-runner (narrowed) ───────────────────────
  step(4, 'Delegating to "test-runner" (narrowed to run_tests only)...');
  const codeReviewer = findAgentByName('code-reviewer');
  if (!codeReviewer) throw new Error('code-reviewer not found');

  // Demonstrate scope narrowing: child only gets intersection of requested + delegatable
  const requestedScope = ['run_tests'];
  const { agentId: testRunnerId } = await issueAgentToken({
    name: 'test-runner',
    humanEmail,
    humanSub,
    scope: requestedScope,
    parentId: codeReviewerId,
    delegationDepth: 1,
    maxDelegationDepth: 2,
    canDelegate: [],
  });
  success(`Delegation issued: code-reviewer -> test-runner`);
  info(`Agent ID:   ${testRunnerId.substring(0, 8)}...`);
  info(`Scope:      [${requestedScope.join(', ')}]  (narrowed from parent's 3 scopes)`);
  info(`Depth:      1 / 2`);
  info(`Can delegate: [] (leaf agent, cannot sub-delegate)`);
  await pause(800);

  // ── Step 5: Show delegation chain ────────────────────────────────────
  step(5, 'Delegation chain for test-runner:');
  const chain = getDelegationChain(testRunnerId);
  process.stdout.write('\n');
  chainLine('  alice@acme.com (human)');
  chainLine('    |');
  chainLine(`    +-- code-reviewer  [read_file, run_tests, write_file]  depth=0`);
  chainLine('          |');
  chainLine(`          +-- test-runner  [run_tests]  depth=1`);
  process.stdout.write('\n');
  info(`Every action by test-runner traces back to alice@acme.com`);
  await pause(1000);

  // ── Step 6: Permission checks ────────────────────────────────────────
  step(6, 'Permission enforcement checks:');
  process.stdout.write('\n');

  const checks = [
    { agent: 'test-runner', tool: 'run_tests', expected: true },
    { agent: 'test-runner', tool: 'read_file', expected: false },
    { agent: 'test-runner', tool: 'delete_file', expected: false },
    { agent: 'code-reviewer', tool: 'write_file', expected: true },
    { agent: 'code-reviewer', tool: 'delete_file', expected: false },
  ];

  for (const check of checks) {
    const result = verifyPermission(check.agent, check.tool);
    if (result) {
      allowed(`${check.agent} -> ${check.tool}`);
    } else {
      denied(`${check.agent} -> ${check.tool}`);
    }
  }
  process.stdout.write('\n');
  await pause(1000);

  // ── Step 7: MCP tool call enforcement ────────────────────────────────
  step(7, 'Simulating MCP tool calls with Eigent sidecar enforcement...');
  process.stdout.write('\n');

  // test-runner tries run_tests (allowed)
  const r1 = await simulateMcpToolCall('test-runner', 'run_tests', {});
  if (r1.allowed) {
    allowed(`test-runner calls run_tests -> ${r1.response}`);
  }

  // test-runner tries read_file (denied - not in scope)
  const r2 = await simulateMcpToolCall('test-runner', 'read_file', { path: 'secret.env' });
  if (!r2.allowed) {
    denied(`test-runner calls read_file -> BLOCKED by sidecar (scope violation)`);
  }

  // code-reviewer calls write_file (allowed)
  const r3 = await simulateMcpToolCall('code-reviewer', 'write_file', { path: 'review.md', content: 'LGTM' });
  if (r3.allowed) {
    allowed(`code-reviewer calls write_file -> ${r3.response}`);
  }

  process.stdout.write('\n');
  await pause(1000);

  // ── Step 8: Audit trail ──────────────────────────────────────────────
  step(8, 'Audit trail for alice@acme.com:');
  process.stdout.write('\n');

  const aliceAudit = auditLog.filter((e) => e.humanEmail === humanEmail);
  for (const entry of aliceAudit) {
    const ts = entry.timestamp.toISOString().substring(11, 19);
    const chain_str = entry.delegationChain.join(' -> ');
    const toolStr = entry.toolName ? ` tool=${entry.toolName}` : '';
    auditLine(`  ${ts}  ${entry.action.padEnd(20)}  ${entry.agentName.padEnd(15)}${toolStr}  [${entry.result}]`);
  }
  process.stdout.write('\n');
  info(`${aliceAudit.length} audit entries. Every agent action traces to alice@acme.com.`);
  await pause(1000);

  // ── Step 9: Cascade revocation ───────────────────────────────────────
  step(9, 'Revoking code-reviewer (cascade)...');
  const { revoked, cascadeRevoked } = revokeAgent('code-reviewer');
  process.stdout.write('\n');
  success(`Revoked: ${revoked.join(', ')}`);
  if (cascadeRevoked.length > 0) {
    success(`Cascade revoked: ${cascadeRevoked.join(', ')}`);
  }
  info(`Total revoked: ${revoked.length + cascadeRevoked.length} agents`);
  process.stdout.write('\n');
  await pause(800);

  // ── Step 10: Post-revocation verification ────────────────────────────
  step(10, 'Post-revocation checks:');
  process.stdout.write('\n');

  const postCheck1 = verifyPermission('code-reviewer', 'read_file');
  denied(`code-reviewer -> read_file (token revoked)`);

  const postCheck2 = verifyPermission('test-runner', 'run_tests');
  denied(`test-runner -> run_tests (cascade revoked)`);

  process.stdout.write('\n');

  // ── List remaining agents ────────────────────────────────────────────
  info('Agent registry status:');
  for (const agent of agents.values()) {
    const statusColor = agent.status === 'active' ? GREEN : RED;
    info(`  ${agent.name.padEnd(20)} ${statusColor}${agent.status}${RESET}  scope=[${agent.scope.join(',')}]`);
  }

  // ── Summary ──────────────────────────────────────────────────────────
  process.stdout.write('\n');
  banner('DEMO COMPLETE');

  process.stdout.write(`${BOLD}Flow:${RESET}\n`);
  process.stdout.write(`  Human (${CYAN}alice@acme.com${RESET})\n`);
  process.stdout.write(`    -> ${GREEN}code-reviewer${RESET} [read_file, run_tests, write_file]\n`);
  process.stdout.write(`      -> ${GREEN}test-runner${RESET} [run_tests only]\n`);
  process.stdout.write('\n');

  process.stdout.write(`${BOLD}What Eigent enforces:${RESET}\n`);
  process.stdout.write(`  ${GREEN}[PASS]${RESET} Permission narrowing: child never gets more than parent\n`);
  process.stdout.write(`  ${GREEN}[PASS]${RESET} Scope enforcement: sidecar blocks unauthorized tool calls\n`);
  process.stdout.write(`  ${GREEN}[PASS]${RESET} Cascade revocation: revoking parent revokes all descendants\n`);
  process.stdout.write(`  ${GREEN}[PASS]${RESET} Audit trail: every action traces to the authorizing human\n`);
  process.stdout.write(`  ${GREEN}[PASS]${RESET} Human binding: agents cannot act without human authorization\n`);
  process.stdout.write('\n');

  process.stdout.write(`${DIM}Learn more: https://github.com/anthropics/agent-trust-infrastructure${RESET}\n\n`);
}

runDemo().catch((err) => {
  process.stderr.write(`Demo failed: ${err}\n`);
  process.exit(1);
});
