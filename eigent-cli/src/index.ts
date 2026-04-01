#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { input } from '@inquirer/prompts';
import { spawn } from 'node:child_process';
import * as config from './config.js';
import * as api from './api.js';
import * as display from './display.js';

const program = new Command();

program
  .name('eigent')
  .description('Eigent CLI - Agent Identity & Trust Infrastructure')
  .version('1.0.0');

// ─── eigent init ───

program
  .command('init')
  .description('Initialize Eigent for a project')
  .option('-r, --registry <url>', 'Registry URL', 'http://localhost:3456')
  .action(async (opts: { registry: string }) => {
    const spinner = ora('Initializing Eigent...').start();

    try {
      config.ensureEigentHome();
      config.initProjectConfig(opts.registry);

      spinner.text = 'Checking registry connection...';
      const healthy = await api.healthCheck();

      if (healthy) {
        spinner.succeed('Connected to registry.');
      } else {
        spinner.warn('Registry not reachable. Commands will fail until it is running.');
        display.info(`Start the registry: ${chalk.cyan('cd eigent-registry && npm run dev')}`);
      }

      display.blank();
      display.success(`Eigent initialized. Registry at ${chalk.cyan(opts.registry)}`);
      display.info(`Config: ${chalk.gray(config.getProjectDir() + '/config.json')}`);
      display.info(`Keys:   ${chalk.gray(config.getKeysDir())}`);
      display.blank();
    } catch (err: unknown) {
      spinner.fail('Initialization failed.');
      display.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

// ─── eigent login ───

program
  .command('login')
  .description('Authenticate as a human operator (simulated OIDC)')
  .option('-e, --email <email>', 'Email address (skip prompt)')
  .action(async (opts: { email?: string }) => {
    display.banner();

    try {
      let email = opts.email;

      if (!email) {
        email = await input({
          message: 'Enter your email address:',
          validate: (val: string) => {
            if (!val.includes('@')) return 'Please enter a valid email address.';
            return true;
          },
        });
      }

      const spinner = ora('Authenticating...').start();

      // Simulate OIDC: in production this would redirect to an IdP
      const sub = `user-${Buffer.from(email).toString('base64url').slice(0, 12)}`;
      const iss = 'https://eigent.dev/mock-idp';
      const mockToken = Buffer.from(
        JSON.stringify({ sub, email, iss, iat: Math.floor(Date.now() / 1000) })
      ).toString('base64url');

      config.saveSession({
        email,
        sub,
        iss,
        token: mockToken,
        authenticatedAt: new Date().toISOString(),
      });

      spinner.succeed('Authenticated.');
      display.blank();
      display.success(`Logged in as ${chalk.cyan.bold(email)}`);
      display.info(`Session stored in ${chalk.gray('~/.eigent/session.json')}`);
      display.blank();
    } catch (err: unknown) {
      display.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

// ─── eigent issue <agent-name> ───

program
  .command('issue <agent-name>')
  .description('Issue an eigent token for a new agent')
  .requiredOption('-s, --scope <tools>', 'Comma-separated list of allowed tools')
  .option('-t, --ttl <seconds>', 'Token TTL in seconds', '3600')
  .option('-d, --max-depth <depth>', 'Maximum delegation depth', '3')
  .option('--can-delegate <tools>', 'Tools this agent can delegate (default: same as scope)')
  .action(async (agentName: string, opts: {
    scope: string;
    ttl: string;
    maxDepth: string;
    canDelegate?: string;
  }) => {
    const spinner = ora(`Issuing token for ${chalk.cyan(agentName)}...`).start();

    try {
      const session = config.requireSession();
      config.requireProjectConfig();

      const scope = opts.scope.split(',').map((s) => s.trim());
      const canDelegate = opts.canDelegate
        ? opts.canDelegate.split(',').map((s) => s.trim())
        : scope;

      const agent = await api.createAgent({
        name: agentName,
        human_email: session.email,
        human_sub: session.sub,
        human_iss: session.iss,
        scope,
        ttl: parseInt(opts.ttl, 10),
        max_delegation_depth: parseInt(opts.maxDepth, 10),
        can_delegate: canDelegate,
      });

      const token = agent.token ?? '';
      const tokenPath = config.saveToken(agentName, token);

      spinner.succeed('Token issued.');
      display.agentIssued(agent, tokenPath);
    } catch (err: unknown) {
      spinner.fail('Failed to issue token.');
      display.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

// ─── eigent delegate <parent-agent> <child-agent> ───

program
  .command('delegate <parent-agent> <child-agent>')
  .description('Delegate a subset of permissions to a child agent')
  .requiredOption('-s, --scope <tools>', 'Comma-separated list of tools to delegate')
  .option('-t, --ttl <seconds>', 'Token TTL in seconds')
  .option('-d, --max-depth <depth>', 'Maximum further delegation depth')
  .action(async (parentAgent: string, childAgent: string, opts: {
    scope: string;
    ttl?: string;
    maxDepth?: string;
  }) => {
    const spinner = ora(
      `Delegating from ${chalk.cyan(parentAgent)} to ${chalk.cyan(childAgent)}...`
    ).start();

    try {
      config.requireSession();
      config.requireProjectConfig();

      const parentToken = config.requireToken(parentAgent);
      const scope = opts.scope.split(',').map((s) => s.trim());

      // Decode parent token to get parent_id (from JWT payload)
      const parentPayload = decodeTokenPayload(parentToken);

      const child = await api.delegateAgent({
        parent_id: extractAgentId(parentPayload),
        name: childAgent,
        scope,
        ttl: opts.ttl ? parseInt(opts.ttl, 10) : undefined,
        max_delegation_depth: opts.maxDepth ? parseInt(opts.maxDepth, 10) : undefined,
        parent_token: parentToken,
      });

      const childToken = child.token ?? '';
      const tokenPath = config.saveToken(childAgent, childToken);

      spinner.succeed('Delegation successful.');
      display.blank();

      // Show granted vs denied
      const parentScope = Array.isArray(parentPayload.scope) ? parentPayload.scope : [];
      const granted = scope.filter((s) => parentScope.includes(s) || parentScope.length === 0);
      const denied = scope.filter((s) => !parentScope.includes(s) && parentScope.length > 0);

      display.keyValue([
        ['Child Agent', chalk.cyan.bold(childAgent)],
        ['Granted Scope', chalk.green(granted.join(', ') || scope.join(', '))],
        ...(denied.length > 0 ? [['Denied Scope', chalk.red(denied.join(', '))] as [string, string]] : []),
        ['Depth', chalk.white(String(child.delegation_depth))],
        ['Token', chalk.gray(tokenPath)],
      ]);
      display.blank();
    } catch (err: unknown) {
      spinner.fail('Delegation failed.');
      display.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

// ─── eigent revoke <agent-name> ───

program
  .command('revoke <agent-name>')
  .description('Revoke an agent and cascade to its delegates')
  .action(async (agentName: string) => {
    const spinner = ora(`Revoking ${chalk.cyan(agentName)}...`).start();

    try {
      config.requireProjectConfig();

      // Find agent ID from token
      const token = config.requireToken(agentName);
      const payload = decodeTokenPayload(token);
      const agentId = extractAgentId(payload);

      const result = await api.revokeAgent(agentId);

      // Clean up local token files
      config.removeToken(agentName);
      for (const cascaded of result.cascade_revoked) {
        config.removeToken(cascaded.name);
      }

      spinner.succeed('Agent revoked.');
      display.revokeResult(result);
    } catch (err: unknown) {
      spinner.fail('Revocation failed.');
      display.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

// ─── eigent list ───

program
  .command('list')
  .description('List all active agents')
  .option('--all', 'Include revoked agents')
  .action(async (opts: { all?: boolean }) => {
    const spinner = ora('Fetching agents...').start();

    try {
      config.requireProjectConfig();
      const agents = await api.listAgents();

      const filtered = opts.all
        ? agents
        : agents.filter((a) => a.status === 'active');

      spinner.stop();
      display.blank();
      console.log(`  ${chalk.bold('Agents')} ${chalk.gray(`(${filtered.length})`)}`);
      display.agentTable(filtered);
    } catch (err: unknown) {
      spinner.fail('Failed to list agents.');
      display.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

// ─── eigent verify <agent-name> <tool-name> ───

program
  .command('verify <agent-name> <tool-name>')
  .description('Check if an agent is authorized to call a tool')
  .action(async (agentName: string, toolName: string) => {
    const spinner = ora('Verifying...').start();

    try {
      config.requireProjectConfig();

      const token = config.requireToken(agentName);
      const payload = decodeTokenPayload(token);
      const agentId = extractAgentId(payload);

      const result = await api.verifyAgent({
        agent_id: agentId,
        tool: toolName,
        token,
      });

      spinner.stop();
      display.verifyResult(result);
    } catch (err: unknown) {
      spinner.fail('Verification failed.');
      display.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

// ─── eigent chain <agent-name> ───

program
  .command('chain <agent-name>')
  .description('Show the delegation chain for an agent')
  .action(async (agentName: string) => {
    const spinner = ora('Fetching delegation chain...').start();

    try {
      config.requireProjectConfig();

      const token = config.requireToken(agentName);
      const payload = decodeTokenPayload(token);
      const agentId = extractAgentId(payload);

      const chain = await api.getChain(agentId);

      spinner.stop();
      display.blank();
      console.log(`  ${chalk.bold('Delegation Chain')}`);
      display.delegationChain(chain, agentName);
    } catch (err: unknown) {
      spinner.fail('Failed to fetch chain.');
      display.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

// ─── eigent wrap <command> [args...] ───

program
  .command('wrap <command> [args...]')
  .description('Wrap an MCP server with the Eigent enforcing sidecar')
  .requiredOption('-a, --agent <name>', 'Agent name whose token to use')
  .allowUnknownOption()
  .action(async (command: string, args: string[], opts: { agent: string }) => {
    try {
      const projectConfig = config.requireProjectConfig();
      const token = config.requireToken(opts.agent);

      const sidecarArgs = [
        '--mode', 'enforce',
        '--eigent-token', token,
        '--registry-url', projectConfig.registryUrl,
        '--', command, ...args,
      ];

      const sidecar = spawn('eigent-sidecar', sidecarArgs, {
        stdio: 'inherit',
        env: {
          ...process.env,
          EIGENT_TOKEN: token,
          EIGENT_REGISTRY_URL: projectConfig.registryUrl,
        },
      });

      sidecar.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') {
          display.error(
            'eigent-sidecar not found. Install it with: npm install -g @eigent/sidecar'
          );
        } else {
          display.error(`Sidecar error: ${err.message}`);
        }
        process.exit(1);
      });

      sidecar.on('exit', (code) => {
        process.exit(code ?? 0);
      });
    } catch (err: unknown) {
      display.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

// ─── eigent audit ───

program
  .command('audit')
  .description('Query the audit log')
  .option('-a, --agent <name>', 'Filter by agent name')
  .option('-u, --human <email>', 'Filter by human email')
  .option('--action <type>', 'Filter by action type')
  .option('-l, --limit <count>', 'Maximum entries to return', '25')
  .action(async (opts: {
    agent?: string;
    human?: string;
    action?: string;
    limit: string;
  }) => {
    const spinner = ora('Fetching audit log...').start();

    try {
      config.requireProjectConfig();

      const result = await api.queryAudit({
        agent: opts.agent,
        human: opts.human,
        action: opts.action,
        limit: parseInt(opts.limit, 10),
      });

      spinner.stop();
      display.blank();
      console.log(`  ${chalk.bold('Audit Log')} ${chalk.gray(`(${result.total} total)`)}`);
      display.auditTable(result.entries, result.total);
    } catch (err: unknown) {
      spinner.fail('Failed to fetch audit log.');
      display.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

// ─── eigent logout ───

program
  .command('logout')
  .description('Clear the current session')
  .action(() => {
    config.clearSession();
    display.blank();
    display.success('Logged out. Session cleared.');
    display.blank();
  });

// ─── eigent status ───

program
  .command('status')
  .description('Show current Eigent status')
  .action(async () => {
    display.banner();

    const projectConfig = config.loadProjectConfig();
    const session = config.loadSession();
    const tokens = config.listTokenFiles();

    display.keyValue([
      ['Project', projectConfig ? chalk.green('initialized') : chalk.yellow('not initialized')],
      ['Registry', projectConfig?.registryUrl ?? chalk.gray('not configured')],
      ['Session', session ? chalk.green(session.email) : chalk.yellow('not logged in')],
      ['Tokens', tokens.length > 0 ? chalk.cyan(tokens.join(', ')) : chalk.gray('none')],
    ]);

    if (projectConfig) {
      const spinner = ora('Checking registry...').start();
      const healthy = await api.healthCheck();
      spinner.stop();
      display.info(`Registry: ${healthy ? chalk.green('reachable') : chalk.red('unreachable')}`);
    }

    display.blank();
  });

// ─── Helpers ───

interface TokenPayload {
  agent_id?: string;
  sub?: string;
  scope?: string[];
  [key: string]: unknown;
}

function decodeTokenPayload(token: string): TokenPayload {
  try {
    const parts = token.split('.');
    if (parts.length === 3) {
      // Standard JWT
      const payload = Buffer.from(parts[1], 'base64url').toString('utf-8');
      return JSON.parse(payload) as TokenPayload;
    }
    // Fallback: try parsing as JSON directly
    return JSON.parse(Buffer.from(token, 'base64url').toString('utf-8')) as TokenPayload;
  } catch {
    // If we can't decode, return an empty payload
    // The registry should still have the agent info
    return {};
  }
}

function extractAgentId(payload: TokenPayload): string {
  const id = payload.agent_id ?? payload.sub;
  if (!id) {
    throw new Error('Cannot determine agent ID from token. The token may be invalid.');
  }
  return id;
}

// ─── Run ───

program.parse();
