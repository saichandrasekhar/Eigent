import chalk from 'chalk';
import type {
  AgentRecord,
  ChainNode,
  AuditEntry,
  VerifyResult,
  RevokeResult,
} from './api.js';

// ─── Branding ───

const EIGENT = chalk.bold.cyan('eigent');
const CHECK = chalk.green('\u2713');
const CROSS = chalk.red('\u2717');
const ARROW = chalk.gray('\u2192');
const BULLET = chalk.gray('\u2022');

export function banner(): void {
  console.log();
  console.log(chalk.cyan.bold('  eigent') + chalk.gray(' - Agent Identity & Trust Infrastructure'));
  console.log();
}

// ─── Status Messages ───

export function success(message: string): void {
  console.log(`  ${CHECK} ${message}`);
}

export function error(message: string): void {
  console.log(`  ${CROSS} ${chalk.red(message)}`);
}

export function info(message: string): void {
  console.log(`  ${BULLET} ${chalk.gray(message)}`);
}

export function warn(message: string): void {
  console.log(`  ${chalk.yellow('!')} ${chalk.yellow(message)}`);
}

export function blank(): void {
  console.log();
}

// ─── Key-Value Display ───

export function keyValue(pairs: Array<[string, string]>): void {
  const maxKeyLen = Math.max(...pairs.map(([k]) => k.length));
  for (const [key, value] of pairs) {
    console.log(`  ${chalk.gray(key.padEnd(maxKeyLen))}  ${value}`);
  }
}

// ─── Agent Table ───

export function agentTable(agents: AgentRecord[]): void {
  if (agents.length === 0) {
    info('No agents found.');
    return;
  }

  const header = [
    'Name'.padEnd(20),
    'Scope'.padEnd(30),
    'Depth'.padEnd(7),
    'Human'.padEnd(25),
    'Status'.padEnd(10),
    'Expires',
  ];

  console.log();
  console.log(`  ${chalk.bold.underline(header.join('  '))}`);

  for (const agent of agents) {
    const scope = Array.isArray(agent.scope)
      ? agent.scope.join(', ')
      : agent.scope;
    const status = agent.status === 'active'
      ? chalk.green('active')
      : chalk.red(agent.status);
    const expires = formatRelativeTime(agent.expires_at);

    const row = [
      chalk.white(agent.name.padEnd(20)),
      chalk.cyan(truncate(scope, 30).padEnd(30)),
      chalk.gray(String(agent.delegation_depth).padEnd(7)),
      chalk.gray(truncate(agent.human_email, 25).padEnd(25)),
      status.padEnd(10 + (status.length - agent.status.length)),
      chalk.gray(expires),
    ];

    console.log(`  ${row.join('  ')}`);
  }
  console.log();
}

// ─── Verify Result ───

export function verifyResult(result: VerifyResult): void {
  console.log();

  if (result.allowed) {
    const scope = Array.isArray(result.scope) ? result.scope.join(', ') : result.scope;
    console.log(
      `  ${chalk.green.bold('ALLOWED')}: agent ${chalk.cyan(`'${result.agent_name}'`)} ` +
      `can call ${chalk.yellow(`'${result.tool}'`)} ` +
      `(authorized by ${chalk.white(result.human_email)}, depth ${result.delegation_depth})`
    );
    info(`Scope: [${scope}]`);
  } else {
    const scope = Array.isArray(result.scope) ? result.scope.join(', ') : result.scope;
    console.log(
      `  ${chalk.red.bold('DENIED')}: agent ${chalk.cyan(`'${result.agent_name}'`)} ` +
      `cannot call ${chalk.yellow(`'${result.tool}'`)} ` +
      `(not in scope [${scope}])`
    );
    if (result.reason) {
      info(`Reason: ${result.reason}`);
    }
  }
  console.log();
}

// ─── Delegation Chain (Tree) ───

export function delegationChain(chain: ChainNode[], targetName?: string): void {
  console.log();

  if (chain.length === 0) {
    info('No delegation chain found.');
    return;
  }

  for (let i = 0; i < chain.length; i++) {
    const node = chain[i];
    const indent = '    '.repeat(i);
    const connector = i === 0 ? '' : '\u2514\u2500 ';
    const treeLine = i > 0 ? '    '.repeat(i - 1) + '    ' : '';

    if (node.type === 'human') {
      console.log(
        `  ${treeLine}${connector}${chalk.white(node.email ?? node.name)} ${chalk.gray('(human)')}`
      );
    } else {
      const scope = node.scope ? node.scope.join(', ') : '';
      const isTarget = targetName && node.name === targetName;
      const marker = isTarget ? chalk.yellow(' \u2190 this agent') : '';
      const nameStr = isTarget
        ? chalk.cyan.bold(node.name)
        : chalk.cyan(node.name);

      console.log(
        `  ${treeLine}${connector}${nameStr} ` +
        `${chalk.gray('[')}${chalk.white(scope)}${chalk.gray(']')} ` +
        `${chalk.gray(`(depth ${node.delegation_depth})`)}${marker}`
      );
    }
  }
  console.log();
}

// ─── Revoke Result ───

export function revokeResult(result: RevokeResult): void {
  console.log();
  const cascadeNames = result.cascade_revoked.map((c) => c.name).join(', ');
  if (result.cascade_revoked.length > 0) {
    success(
      `Revoked ${chalk.cyan(result.revoked_name)}. ` +
      `Cascade revoked: ${chalk.yellow(cascadeNames)} ` +
      `(${chalk.white(String(result.total_revoked))} total)`
    );
  } else {
    success(`Revoked ${chalk.cyan(result.revoked_name)}.`);
  }
  console.log();
}

// ─── Audit Table ───

export function auditTable(entries: AuditEntry[], total: number): void {
  if (entries.length === 0) {
    info('No audit entries found.');
    return;
  }

  const header = [
    'Timestamp'.padEnd(20),
    'Agent'.padEnd(18),
    'Human'.padEnd(22),
    'Action'.padEnd(14),
    'Tool'.padEnd(16),
    'Details',
  ];

  console.log();
  console.log(`  ${chalk.bold.underline(header.join('  '))}`);

  for (const entry of entries) {
    const ts = formatTimestamp(entry.timestamp);
    const agentName = entry.agent_name ?? entry.agent_id.slice(0, 8);
    const details = entry.details
      ? truncate(typeof entry.details === 'string' ? entry.details : JSON.stringify(entry.details), 30)
      : '';

    const row = [
      chalk.gray(ts.padEnd(20)),
      chalk.cyan(truncate(agentName, 18).padEnd(18)),
      chalk.gray(truncate(entry.human_email, 22).padEnd(22)),
      actionColor(entry.action).padEnd(14 + actionColorLen(entry.action)),
      chalk.yellow((entry.tool_name ?? '-').padEnd(16)),
      chalk.gray(details),
    ];

    console.log(`  ${row.join('  ')}`);
  }

  if (total > entries.length) {
    console.log();
    info(`Showing ${entries.length} of ${total} entries. Use --limit to see more.`);
  }
  console.log();
}

// ─── Agent Issue Summary ───

export function agentIssued(agent: AgentRecord, tokenPath: string): void {
  console.log();
  success(`Agent ${chalk.cyan.bold(agent.name)} issued successfully.`);
  console.log();
  keyValue([
    ['Agent ID', chalk.white(agent.id)],
    ['Name', chalk.cyan(agent.name)],
    ['Scope', chalk.yellow(Array.isArray(agent.scope) ? agent.scope.join(', ') : agent.scope)],
    ['Depth', chalk.white(String(agent.delegation_depth))],
    ['Max Depth', chalk.white(String(agent.max_delegation_depth))],
    ['Human', chalk.white(agent.human_email)],
    ['Expires', chalk.gray(formatRelativeTime(agent.expires_at))],
    ['Token', chalk.gray(tokenPath)],
  ]);
  console.log();
}

// ─── Helpers ───

function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max - 1) + '\u2026' : str;
}

function formatRelativeTime(isoDate: string): string {
  const date = new Date(isoDate);
  const now = new Date();
  const diffMs = date.getTime() - now.getTime();

  if (diffMs < 0) return 'expired';

  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 60) return `${diffMins}m`;

  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h`;

  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d`;
}

function formatTimestamp(isoDate: string): string {
  const d = new Date(isoDate);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hours = String(d.getHours()).padStart(2, '0');
  const mins = String(d.getMinutes()).padStart(2, '0');
  const secs = String(d.getSeconds()).padStart(2, '0');
  return `${month}-${day} ${hours}:${mins}:${secs}`;
}

function actionColor(action: string): string {
  switch (action) {
    case 'issue':
    case 'create':
      return chalk.green(action);
    case 'delegate':
      return chalk.blue(action);
    case 'revoke':
      return chalk.red(action);
    case 'verify':
      return chalk.yellow(action);
    case 'tool_call':
      return chalk.cyan(action);
    default:
      return chalk.white(action);
  }
}

function actionColorLen(action: string): number {
  return actionColor(action).length - action.length;
}
