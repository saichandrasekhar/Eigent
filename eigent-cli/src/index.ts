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
  .description('Authenticate as a human operator')
  .option('-e, --email <email>', 'Email address (skip prompt, demo mode)')
  .option('--demo-mode', 'Use simulated authentication (no OIDC)')
  .action(async (opts: { email?: string; demoMode?: boolean }) => {
    display.banner();

    try {
      if (opts.demoMode || opts.email) {
        // Demo mode: prompt for email (original behavior)
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

        const spinner = ora('Authenticating (demo mode)...').start();

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
          verified: false,
        });

        spinner.succeed('Authenticated (demo mode).');
        display.blank();
        display.success(`Logged in as ${chalk.cyan.bold(email)} ${chalk.yellow('(unverified - demo mode)')}`);
        display.info(`Session stored in ${chalk.gray('~/.eigent/session.json')}`);
        display.blank();
      } else {
        // OIDC mode: initiate real authentication via the registry
        const spinner = ora('Initiating OIDC authentication...').start();

        const projectConfig = config.loadProjectConfig();
        const registryUrl = projectConfig?.registryUrl ?? 'http://localhost:3456';

        // Request authorization URL from the registry
        const loginRes = await fetch(`${registryUrl}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ redirect_uri: `${registryUrl}/api/auth/callback` }),
        });

        if (!loginRes.ok) {
          const errorBody = await loginRes.json().catch(() => ({ error: 'Unknown error' })) as Record<string, unknown>;
          spinner.fail('OIDC login initiation failed.');
          display.error(String(errorBody.error ?? errorBody.message ?? 'Registry returned an error'));
          display.info(`Tip: Use ${chalk.cyan('eigent login --demo-mode')} for development without OIDC.`);
          process.exit(1);
        }

        const loginData = await loginRes.json() as {
          authorization_url: string;
          state: string;
          provider: { type: string; issuer: string };
        };

        spinner.succeed('OIDC flow initiated.');
        display.blank();
        display.info(`Provider: ${chalk.cyan(loginData.provider.type)} (${chalk.gray(loginData.provider.issuer)})`);
        display.blank();
        display.info('Open this URL in your browser to authenticate:');
        display.blank();
        console.log(`  ${chalk.cyan.underline(loginData.authorization_url)}`);
        display.blank();

        // Try to open the browser automatically
        const openCommand = process.platform === 'darwin' ? 'open'
          : process.platform === 'win32' ? 'start'
          : 'xdg-open';

        try {
          spawn(openCommand, [loginData.authorization_url], { detached: true, stdio: 'ignore' }).unref();
          display.info(chalk.gray('(Browser opened automatically)'));
        } catch {
          display.info(chalk.gray('(Could not open browser automatically)'));
        }

        display.blank();

        // Wait for the user to complete authentication
        const authCode = await input({
          message: 'Paste the authorization code from the callback:',
          validate: (val: string) => {
            if (!val.trim()) return 'Authorization code is required.';
            return true;
          },
        });

        const callbackSpinner = ora('Exchanging code for session...').start();

        // Exchange the code via the registry callback endpoint
        const callbackRes = await fetch(`${registryUrl}/api/auth/callback`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            code: authCode.trim(),
            state: loginData.state,
          }),
        });

        if (!callbackRes.ok) {
          const errorBody = await callbackRes.json().catch(() => ({ error: 'Unknown error' })) as Record<string, unknown>;
          callbackSpinner.fail('Authentication failed.');
          display.error(String(errorBody.error ?? errorBody.details ?? 'Token exchange failed'));
          process.exit(1);
        }

        const sessionData = await callbackRes.json() as {
          session_token: string;
          human_email: string;
          human_sub: string;
          human_iss: string;
          provider_type: string;
          expires_at: string;
          identity_verified: boolean;
        };

        config.saveSession({
          email: sessionData.human_email,
          sub: sessionData.human_sub,
          iss: sessionData.human_iss,
          token: sessionData.session_token,
          authenticatedAt: new Date().toISOString(),
          verified: true,
          providerType: sessionData.provider_type,
        });

        callbackSpinner.succeed('Authenticated.');
        display.blank();

        const providerLabel = sessionData.provider_type.charAt(0).toUpperCase() + sessionData.provider_type.slice(1);
        display.success(
          `Authenticated as ${chalk.cyan.bold(sessionData.human_email)} via ${chalk.green(providerLabel)} ${chalk.green('(verified)')}`
        );
        display.info(`Session stored in ${chalk.gray('~/.eigent/session.json')}`);
        display.info(`Session expires: ${chalk.gray(sessionData.expires_at)}`);
        display.blank();
      }
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

// ─── eigent compliance-report ───

program
  .command('compliance-report')
  .description('Generate a compliance report (PDF-ready HTML)')
  .option('-p, --period <period>', 'Reporting period (e.g. 30d, 7d, 90d)', '30d')
  .option('-f, --framework <framework>', 'Framework: eu-ai-act, soc2, all', 'all')
  .option('-o, --output <path>', 'Output file path', 'compliance-report.html')
  .option('-u, --human <email>', 'Filter by human email')
  .option('--agents <ids>', 'Comma-separated agent IDs (default: all)')
  .option('--open', 'Open report in browser after generation')
  .action(async (opts: {
    period: string;
    framework: string;
    output: string;
    human?: string;
    agents?: string;
    open?: boolean;
  }) => {
    const spinner = ora('Generating compliance report...').start();

    try {
      const projectConfig = config.requireProjectConfig();

      const params = new URLSearchParams();
      params.set('period', opts.period);
      params.set('framework', opts.framework);
      params.set('format', 'html');
      if (opts.human) params.set('human', opts.human);
      if (opts.agents) params.set('agents', opts.agents);

      const baseUrl = projectConfig.registryUrl;
      const url = `${baseUrl}/api/compliance/report?${params.toString()}`;

      const res = await fetch(url);
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Registry returned ${res.status}: ${text}`);
      }

      const html = await res.text();

      const fs = await import('node:fs');
      const path = await import('node:path');
      const outputPath = path.resolve(opts.output);
      fs.writeFileSync(outputPath, html, 'utf-8');

      spinner.succeed('Compliance report generated.');
      display.blank();
      display.success(`Report saved to ${chalk.cyan(outputPath)}`);
      display.info(`Period: ${chalk.white(opts.period)} | Framework: ${chalk.white(opts.framework)}`);
      if (opts.human) display.info(`Filtered by: ${chalk.white(opts.human)}`);
      display.blank();

      if (opts.open) {
        const { exec } = await import('node:child_process');
        const openCmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
        exec(`${openCmd} "${outputPath}"`);
      }
    } catch (err: unknown) {
      spinner.fail('Failed to generate compliance report.');
      display.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

// ─── eigent rotate <agent-name> ───

program
  .command('rotate <agent-name>')
  .description('Rotate an agent token (issues new token, old expires after grace period)')
  .action(async (agentName: string) => {
    const spinner = ora(`Rotating token for ${chalk.cyan(agentName)}...`).start();

    try {
      config.requireProjectConfig();

      const token = config.requireToken(agentName);
      const payload = decodeTokenPayload(token);
      const agentId = extractAgentId(payload);

      const result = await api.rotateAgentToken(agentId);

      // Save the new token
      config.saveToken(agentName, result.new_token);

      spinner.succeed('Token rotated.');
      display.blank();
      display.keyValue([
        ['Agent', chalk.cyan.bold(agentName)],
        ['Agent ID', chalk.white(result.agent_id)],
        ['Old Token Expires', chalk.yellow(result.old_token_expires)],
        ['New Token', chalk.green('saved')],
      ]);
      display.blank();
      display.info('Old token is still valid for 5 minutes for graceful handoff.');
      display.blank();
    } catch (err: unknown) {
      spinner.fail('Token rotation failed.');
      display.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

// ─── eigent deprovision <agent-name> ───

program
  .command('deprovision <agent-name>')
  .description('Permanently deprovision an agent (archived, not deleted)')
  .action(async (agentName: string) => {
    const spinner = ora(`Deprovisioning ${chalk.cyan(agentName)}...`).start();

    try {
      config.requireProjectConfig();

      const token = config.requireToken(agentName);
      const payload = decodeTokenPayload(token);
      const agentId = extractAgentId(payload);

      const result = await api.deprovisionAgent(agentId);

      // Remove local token
      config.removeToken(agentName);

      spinner.succeed('Agent deprovisioned.');
      display.blank();
      display.keyValue([
        ['Agent', chalk.cyan.bold(result.agent_name)],
        ['Agent ID', chalk.white(result.agent_id)],
        ['Deprovisioned At', chalk.gray(result.deprovisioned_at)],
        ['Cascade Affected', chalk.yellow(String(result.total_affected))],
      ]);
      display.blank();
      display.info('Agent is archived for audit purposes. This action is permanent.');
      display.blank();
    } catch (err: unknown) {
      spinner.fail('Deprovisioning failed.');
      display.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

// ─── eigent stale ───

program
  .command('stale')
  .description('List stale agents (no heartbeat within threshold)')
  .option('-t, --threshold <minutes>', 'Staleness threshold in minutes', '30')
  .action(async (opts: { threshold: string }) => {
    const spinner = ora('Checking for stale agents...').start();

    try {
      config.requireProjectConfig();

      const result = await api.listStaleAgents(parseInt(opts.threshold, 10));

      spinner.stop();
      display.blank();

      if (result.stale_agents.length === 0) {
        display.success('No stale agents found.');
      } else {
        display.warn(`${result.total} stale agent(s) found (threshold: ${result.threshold_minutes}m)`);
        display.blank();

        const header = [
          'Name'.padEnd(20),
          'Human'.padEnd(25),
          'Last Seen'.padEnd(15),
          'Status',
        ];
        console.log(`  ${chalk.bold.underline(header.join('  '))}`);

        for (const agent of result.stale_agents) {
          const lastSeen = agent.last_seen_at
            ? `${agent.minutes_since_seen}m ago`
            : 'never';
          const row = [
            chalk.cyan(agent.name.padEnd(20)),
            chalk.gray(agent.human_email.slice(0, 25).padEnd(25)),
            chalk.yellow(lastSeen.padEnd(15)),
            chalk.red(agent.status),
          ];
          console.log(`  ${row.join('  ')}`);
        }
      }
      display.blank();
    } catch (err: unknown) {
      spinner.fail('Failed to check stale agents.');
      display.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

// ─── eigent usage ───

program
  .command('usage')
  .description('Show usage statistics')
  .option('-a, --agent <name>', 'Show usage for a specific agent')
  .option('-h, --hours <hours>', 'Time window in hours', '24')
  .action(async (opts: { agent?: string; hours: string }) => {
    const spinner = ora('Fetching usage stats...').start();

    try {
      config.requireProjectConfig();
      const hours = parseInt(opts.hours, 10);

      if (opts.agent) {
        // Agent-specific usage
        const token = config.requireToken(opts.agent);
        const payload = decodeTokenPayload(token);
        const agentId = extractAgentId(payload);

        const result = await api.getAgentUsage(agentId, hours);
        spinner.stop();
        display.blank();
        console.log(`  ${chalk.bold('Usage')} for ${chalk.cyan(result.agent_name)} ${chalk.gray(`(last ${hours}h)`)}`);
        display.blank();

        if (result.usage.length === 0) {
          display.info('No usage recorded.');
        } else {
          const header = [
            'Hour'.padEnd(22),
            'Tool Calls'.padEnd(12),
            'Blocked'.padEnd(10),
            'Errors',
          ];
          console.log(`  ${chalk.bold.underline(header.join('  '))}`);

          for (const u of result.usage) {
            const hourStr = new Date(u.hour).toLocaleString();
            const row = [
              chalk.gray(hourStr.padEnd(22)),
              chalk.green(String(u.tool_calls).padEnd(12)),
              chalk.yellow(String(u.blocked_calls).padEnd(10)),
              u.errors > 0 ? chalk.red(String(u.errors)) : chalk.gray('0'),
            ];
            console.log(`  ${row.join('  ')}`);
          }
        }
      } else {
        // Org-wide summary
        const result = await api.getUsageSummary(hours);
        spinner.stop();
        display.blank();
        console.log(`  ${chalk.bold('Usage Summary')} ${chalk.gray(`(last ${hours}h)`)}`);
        display.blank();
        display.keyValue([
          ['Total Tool Calls', chalk.green(String(result.total_tool_calls))],
          ['Blocked Calls', chalk.yellow(String(result.total_blocked_calls))],
          ['Errors', result.total_errors > 0 ? chalk.red(String(result.total_errors)) : chalk.gray('0')],
          ['Active Agents', chalk.cyan(String(result.active_agents))],
        ]);

        if (result.top_agents.length > 0) {
          display.blank();
          console.log(`  ${chalk.bold('Top Agents')}`);
          for (const agent of result.top_agents) {
            display.info(`${agent.agent_name ?? agent.agent_id.slice(0, 8)}: ${chalk.green(String(agent.total_calls))} calls`);
          }
        }
      }
      display.blank();
    } catch (err: unknown) {
      spinner.fail('Failed to fetch usage stats.');
      display.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

// ─── eigent explain <agent-name> <tool-name> ───

program
  .command('explain <agent-name> <tool-name>')
  .description('Explain in detail why a tool call would be allowed or denied')
  .action(async (agentName: string, toolName: string) => {
    const spinner = ora('Analyzing permissions...').start();

    try {
      config.requireProjectConfig();

      const token = config.requireToken(agentName);
      const payload = decodeTokenPayload(token);
      const agentId = extractAgentId(payload);

      const result = await api.explainAccess({
        agent_id: agentId,
        tool: toolName,
        token,
      });

      spinner.stop();
      display.explainResult(result);
    } catch (err: unknown) {
      spinner.fail('Explain failed.');

      // If the API doesn't support /api/explain yet, fall back to local explain
      if (err instanceof Error && err.message.includes('404')) {
        spinner.stop();
        try {
          const token = config.requireToken(agentName);
          const payload = decodeTokenPayload(token);
          const agentId = extractAgentId(payload);
          const scope = Array.isArray(payload.scope) ? payload.scope : [];
          const allowed = scope.includes(toolName) || scope.includes('*');

          // Fetch chain for context
          let chain: api.ChainNode[] = [];
          try {
            chain = await api.getChain(agentId);
          } catch {
            // chain unavailable
          }

          const result: api.ExplainResult = {
            allowed,
            agent_id: agentId,
            agent_name: agentName,
            tool: toolName,
            scope,
            human_email: (payload as Record<string, unknown>).human_email as string ?? 'unknown',
            human_iss: (payload as Record<string, unknown>).human_iss as string ?? 'unknown',
            delegation_depth: (payload as Record<string, unknown>).delegation_depth as number ?? 0,
            max_delegation_depth: (payload as Record<string, unknown>).max_delegation_depth as number ?? 3,
            reason: allowed
              ? `Tool '${toolName}' is in agent scope [${scope.join(', ')}]`
              : `Tool '${toolName}' is not in agent scope [${scope.join(', ')}]`,
            chain,
            policy_evaluations: [],
            default_action: 'allow',
          };

          display.explainResult(result);
        } catch (fallbackErr: unknown) {
          display.error(fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr));
          process.exit(1);
        }
      } else {
        display.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    }
  });

// ─── eigent trace <event-id> ───

program
  .command('trace <event-id>')
  .description('Show the full trace for a specific audit event')
  .action(async (eventId: string) => {
    const spinner = ora('Fetching trace...').start();

    try {
      config.requireProjectConfig();

      const event = await api.getTraceEvent(eventId);

      spinner.stop();
      display.traceEvent(event);
    } catch (err: unknown) {
      spinner.fail('Trace fetch failed.');

      // Fall back to regular audit query if trace endpoint doesn't exist
      if (err instanceof Error && err.message.includes('404')) {
        try {
          const auditResult = await api.queryAudit({ limit: 500 });
          const entry = auditResult.entries.find(e => e.id === eventId);

          if (!entry) {
            display.error(`Audit event '${eventId}' not found.`);
            process.exit(1);
          }

          // Build a trace event from the audit entry
          let chain: api.ChainNode[] = [];
          try {
            chain = await api.getChain(entry.agent_id);
          } catch {
            // chain unavailable
          }

          const traceData: api.TraceEvent = {
            id: entry.id,
            timestamp: entry.timestamp,
            action: entry.action,
            agent_id: entry.agent_id,
            agent_name: entry.agent_name ?? entry.agent_id.slice(0, 8),
            human_email: entry.human_email,
            tool_name: entry.tool_name,
            details: entry.details ? (typeof entry.details === 'string' ? JSON.parse(entry.details) : entry.details) as Record<string, unknown> : null,
            delegation_chain: entry.delegation_chain,
            chain,
            decision: entry.action.includes('blocked') ? 'deny' : entry.action.includes('allowed') ? 'allow' : null,
            reason: entry.details ? String(entry.details) : null,
            policy_rule: null,
            audit_hash: null,
            hash_verified: false,
          };

          display.traceEvent(traceData);
        } catch (fallbackErr: unknown) {
          display.error(fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr));
          process.exit(1);
        }
      } else {
        display.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
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

// ─── eigent quickstart ───

program
  .command('quickstart')
  .description('Get Eigent running in 30 seconds — init, login, issue token, detect MCP servers')
  .option('-r, --registry <url>', 'Registry URL', 'http://localhost:3456')
  .option('-e, --email <email>', 'Email for demo login', 'developer@eigent.dev')
  .action(async (opts: { registry: string; email: string }) => {
    display.banner();
    const steps = {
      total: 5,
      current: 0,
    };

    const step = (label: string): void => {
      steps.current++;
      console.log(`  ${chalk.cyan(`[${steps.current}/${steps.total}]`)} ${label}`);
    };

    try {
      // Step 1: Check registry
      step('Checking registry...');
      let registryReachable = false;
      try {
        const res = await fetch(`${opts.registry}/health`, {
          signal: AbortSignal.timeout(3000),
        });
        registryReachable = res.ok;
      } catch {
        registryReachable = false;
      }

      if (!registryReachable) {
        display.warn(
          `Registry not reachable at ${chalk.cyan(opts.registry)}.\n` +
          `    Start it with one of:\n` +
          `      ${chalk.cyan('cd eigent-registry && npm run dev')}\n` +
          `      ${chalk.cyan('docker compose up -d')}\n` +
          `    Then re-run: ${chalk.cyan('eigent quickstart')}\n` +
          `    Docs: https://eigent.dev/getting-started`
        );
        display.blank();
        display.info('Continuing with initialization (commands will work once registry is running)...');
        display.blank();
      } else {
        display.success(`Registry reachable at ${chalk.cyan(opts.registry)}`);
      }

      // Step 2: Init
      step('Initializing Eigent...');
      config.ensureEigentHome();
      config.initProjectConfig(opts.registry);
      display.success('Project initialized.');

      // Step 3: Demo login
      step('Authenticating (demo mode)...');
      const email = opts.email;
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
        verified: false,
      });
      display.success(`Logged in as ${chalk.cyan(email)} ${chalk.yellow('(demo mode)')}`);

      // Step 4: Detect MCP configs and issue token
      step('Detecting MCP servers...');
      const fs = await import('node:fs');
      const path = await import('node:path');
      const os = await import('node:os');
      const home = os.default.homedir();

      interface McpConfig {
        name: string;
        path: string;
        exists: boolean;
      }

      const mcpConfigs: McpConfig[] = [
        {
          name: 'Claude Desktop',
          path: process.platform === 'darwin'
            ? path.default.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
            : path.default.join(home, '.config', 'claude', 'claude_desktop_config.json'),
          exists: false,
        },
        {
          name: 'Cursor',
          path: path.default.join(home, '.cursor', 'mcp.json'),
          exists: false,
        },
        {
          name: 'VS Code',
          path: path.default.join(home, '.vscode', 'mcp.json'),
          exists: false,
        },
      ];

      const detectedConfigs: McpConfig[] = [];
      for (const cfg of mcpConfigs) {
        cfg.exists = fs.default.existsSync(cfg.path);
        if (cfg.exists) {
          detectedConfigs.push(cfg);
          display.info(`Found ${chalk.cyan(cfg.name)} config at ${chalk.gray(cfg.path)}`);
        }
      }

      if (detectedConfigs.length === 0) {
        display.info('No MCP server configs detected (Claude Desktop, Cursor, VS Code).');
        display.info(`You can issue a token manually: ${chalk.cyan('eigent issue my-agent --scope read_file,write_file')}`);
      }

      // Issue a demo token
      const agentName = detectedConfigs.length > 0
        ? detectedConfigs[0].name.toLowerCase().replace(/\s+/g, '-')
        : 'my-agent';

      if (registryReachable) {
        try {
          const agent = await api.createAgent({
            name: agentName,
            human_email: email,
            human_sub: sub,
            human_iss: iss,
            scope: ['read_file', 'write_file', 'run_tests', 'search'],
            ttl: 3600,
            max_delegation_depth: 3,
            can_delegate: ['read_file', 'search'],
          });

          const token = agent.token ?? '';
          config.saveToken(agentName, token);
          display.success(`Token issued for ${chalk.cyan(agentName)}`);
        } catch (err: unknown) {
          display.warn(`Could not issue token: ${err instanceof Error ? err.message : String(err)}`);
          display.info(`Issue manually: ${chalk.cyan(`eigent issue ${agentName} --scope read_file,write_file`)}`);
        }
      } else {
        display.info(`Token will be issued when registry is running. Run: ${chalk.cyan(`eigent issue ${agentName} --scope read_file,write_file`)}`);
      }

      // Step 5: Show summary
      step('Setup complete!');
      display.blank();

      // Show delegation chain if we have a token
      const savedToken = config.loadToken(agentName);
      if (savedToken && registryReachable) {
        try {
          const payload = decodeTokenPayload(savedToken);
          const agentId = extractAgentId(payload);
          const chain = await api.getChain(agentId);
          if (chain.length > 0) {
            console.log(`  ${chalk.bold('Delegation Chain')}`);
            display.delegationChain(chain, agentName);
          }
        } catch {
          // Chain display is best-effort
        }
      }

      console.log(chalk.green.bold('  Eigent is protecting your agents.'));
      if (registryReachable) {
        console.log(`  Dashboard: ${chalk.cyan.underline('http://localhost:3000')}`);
      }
      display.blank();

      display.keyValue([
        ['Config', chalk.gray(config.getProjectDir() + '/config.json')],
        ['Session', chalk.gray('~/.eigent/session.json')],
        ['Tokens', chalk.gray(config.getTokensDir())],
      ]);
      display.blank();

      console.log(`  ${chalk.bold('Next steps:')}`);
      display.info(`Wrap an MCP server: ${chalk.cyan(`eigent wrap -a ${agentName} -- npx @modelcontextprotocol/server-filesystem /tmp`)}`);
      display.info(`Delegate to a sub-agent: ${chalk.cyan(`eigent delegate ${agentName} sub-agent --scope read_file`)}`);
      display.info(`View audit log: ${chalk.cyan('eigent audit')}`);
      display.info(`Docs: ${chalk.cyan.underline('https://eigent.dev/getting-started')}`);
      display.blank();
    } catch (err: unknown) {
      display.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

// ─── Run ───

program.parse();
