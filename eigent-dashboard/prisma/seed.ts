import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  // Clear existing data
  await prisma.finding.deleteMany();
  await prisma.agent.deleteMany();
  await prisma.scan.deleteMany();

  // Create demo scans
  const scan1 = await prisma.scan.create({
    data: {
      targets: JSON.stringify(["~/.claude", "~/.config/mcp", "~/.cursor"]),
      totalAgents: 5,
      totalFindings: 7,
      riskLevel: "critical",
      raw: "{}",
      orgId: "demo-org",
      agents: {
        create: [
          {
            name: "filesystem",
            source: "mcp_config",
            transport: "stdio",
            authStatus: "none",
            configPath: "~/.claude/claude_desktop_config.json",
          },
          {
            name: "github-mcp",
            source: "mcp_config",
            transport: "stdio",
            authStatus: "api_key",
            configPath: "~/.claude/claude_desktop_config.json",
            command: "npx @modelcontextprotocol/server-github",
          },
          {
            name: "slack-bot",
            source: "mcp_config",
            transport: "sse",
            authStatus: "oauth",
            configPath: "~/.config/mcp/config.json",
          },
          {
            name: "unknown-agent-8080",
            source: "env_scan",
            transport: "streamable-http",
            authStatus: "none",
            configPath: null,
          },
          {
            name: "db-query-tool",
            source: "cursor_config",
            transport: "stdio",
            authStatus: "none",
            configPath: "~/.cursor/mcp.json",
          },
        ],
      },
      findings: {
        create: [
          {
            agentName: "filesystem",
            severity: "critical",
            title: "No authentication on filesystem agent",
            description: "The filesystem MCP server has no authentication mechanism. Any process can connect and read/write files.",
            recommendation: "Add authentication layer or restrict to localhost with process verification.",
            category: "auth",
          },
          {
            agentName: "unknown-agent-8080",
            severity: "critical",
            title: "Shadow agent detected on port 8080",
            description: "An unregistered agent was discovered listening on port 8080 with HTTP transport. No configuration file references this agent.",
            recommendation: "Investigate the source of this agent. If legitimate, add to configuration. If not, terminate and audit.",
            category: "shadow",
          },
          {
            agentName: "db-query-tool",
            severity: "high",
            title: "Database agent without authentication",
            description: "The db-query-tool agent connects to databases without any auth verification on the MCP channel.",
            recommendation: "Implement API key or certificate-based authentication for the MCP connection.",
            category: "auth",
          },
          {
            agentName: "github-mcp",
            severity: "medium",
            title: "API key exposed in configuration",
            description: "GitHub personal access token is stored in plaintext in the MCP configuration file.",
            recommendation: "Use environment variables or a secrets manager for API keys.",
            category: "auth",
          },
          {
            agentName: "filesystem",
            severity: "medium",
            title: "Unrestricted filesystem access",
            description: "The filesystem agent has read/write access to the entire home directory without path restrictions.",
            recommendation: "Configure allowedDirectories to limit filesystem access scope.",
            category: "permissions",
          },
          {
            agentName: "slack-bot",
            severity: "low",
            title: "SSE transport without TLS verification",
            description: "The Slack bot agent uses SSE transport but TLS certificate verification is not explicitly enabled.",
            recommendation: "Ensure TLS verification is enabled for all SSE connections.",
            category: "transport",
          },
          {
            agentName: "unknown-agent-8080",
            severity: "high",
            title: "Unapproved network listener",
            description: "An agent is listening on a network port without organizational approval or registration.",
            recommendation: "All network-accessible agents must be registered in the agent inventory and approved.",
            category: "shadow",
          },
        ],
      },
    },
  });

  // Create a second scan (slightly better)
  const scan2 = await prisma.scan.create({
    data: {
      timestamp: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000), // 3 days ago
      targets: JSON.stringify(["~/.claude", "~/.config/mcp"]),
      totalAgents: 3,
      totalFindings: 4,
      riskLevel: "high",
      raw: "{}",
      orgId: "demo-org",
      agents: {
        create: [
          {
            name: "filesystem",
            source: "mcp_config",
            transport: "stdio",
            authStatus: "none",
            configPath: "~/.claude/claude_desktop_config.json",
            firstSeen: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
            lastSeen: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
          },
          {
            name: "github-mcp",
            source: "mcp_config",
            transport: "stdio",
            authStatus: "api_key",
            configPath: "~/.claude/claude_desktop_config.json",
            firstSeen: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
            lastSeen: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
          },
          {
            name: "slack-bot",
            source: "mcp_config",
            transport: "sse",
            authStatus: "oauth",
            configPath: "~/.config/mcp/config.json",
            firstSeen: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
            lastSeen: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
          },
        ],
      },
      findings: {
        create: [
          {
            agentName: "filesystem",
            severity: "critical",
            title: "No authentication on filesystem agent",
            description: "The filesystem MCP server has no authentication mechanism.",
            recommendation: "Add authentication layer.",
            category: "auth",
          },
          {
            agentName: "github-mcp",
            severity: "medium",
            title: "API key exposed in configuration",
            description: "GitHub PAT stored in plaintext.",
            recommendation: "Use environment variables.",
            category: "auth",
          },
          {
            agentName: "filesystem",
            severity: "medium",
            title: "Unrestricted filesystem access",
            description: "No path restrictions configured.",
            recommendation: "Configure allowedDirectories.",
            category: "permissions",
          },
          {
            agentName: "slack-bot",
            severity: "low",
            title: "SSE transport without TLS verification",
            description: "TLS cert verification not explicitly enabled.",
            recommendation: "Enable TLS verification.",
            category: "transport",
          },
        ],
      },
    },
  });

  // Third scan (oldest)
  await prisma.scan.create({
    data: {
      timestamp: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
      targets: JSON.stringify(["~/.claude"]),
      totalAgents: 2,
      totalFindings: 2,
      riskLevel: "medium",
      raw: "{}",
      orgId: "demo-org",
      agents: {
        create: [
          {
            name: "filesystem",
            source: "mcp_config",
            transport: "stdio",
            authStatus: "none",
            configPath: "~/.claude/claude_desktop_config.json",
            firstSeen: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
            lastSeen: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
          },
          {
            name: "github-mcp",
            source: "mcp_config",
            transport: "stdio",
            authStatus: "api_key",
            configPath: "~/.claude/claude_desktop_config.json",
            firstSeen: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
            lastSeen: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
          },
        ],
      },
      findings: {
        create: [
          {
            agentName: "filesystem",
            severity: "medium",
            title: "No authentication on filesystem agent",
            description: "The filesystem MCP server has no authentication.",
            recommendation: "Add authentication.",
            category: "auth",
          },
          {
            agentName: "github-mcp",
            severity: "medium",
            title: "API key in plaintext",
            description: "GitHub PAT stored in config file.",
            recommendation: "Use env vars or secrets manager.",
            category: "auth",
          },
        ],
      },
    },
  });

  console.log("Seed data created:");
  console.log(`  Scan 1: ${scan1.id} (${scan1.totalFindings} findings)`);
  console.log(`  Scan 2: ${scan2.id} (${scan2.totalFindings} findings)`);
  console.log("  Scan 3: created (2 findings)");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
