/**
 * Mock MCP Server for Eigent Demo
 *
 * Implements the MCP (Model Context Protocol) over stdio with three tools:
 *   - read_file: Read contents of a file
 *   - write_file: Write content to a file
 *   - delete_file: Delete a file
 *
 * This server responds to JSON-RPC messages on stdin and writes responses
 * to stdout. It does NOT perform real filesystem operations — all responses
 * are mocked for demo purposes.
 *
 * Protocol: JSON-RPC 2.0 over newline-delimited JSON (NDJSON) on stdio
 */

import { createInterface } from 'node:readline';

// ── Types ───────────────────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

// ── Tool definitions ────────────────────────────────────────────────────

const TOOLS: ToolDefinition[] = [
  {
    name: 'read_file',
    description: 'Read the contents of a file at the specified path',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file to read' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Write content to a file at the specified path',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file to write' },
        content: { type: 'string', description: 'Content to write to the file' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'delete_file',
    description: 'Delete a file at the specified path',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file to delete' },
      },
      required: ['path'],
    },
  },
];

// ── Mock filesystem ─────────────────────────────────────────────────────

const MOCK_FILES: Record<string, string> = {
  '/src/main.ts': 'export function main() { return "Hello from Eigent!"; }',
  '/src/config.json': '{ "version": "1.0.0", "name": "eigent-demo" }',
  '/README.md': '# Eigent Demo\n\nOAuth for AI Agents.',
  '/tests/main.test.ts': 'test("main returns greeting", () => { expect(main()).toBe("Hello from Eigent!"); });',
};

// ── Tool execution ──────────────────────────────────────────────────────

function executeTool(
  toolName: string,
  args: Record<string, unknown>,
): { content: Array<{ type: string; text: string }>; isError?: boolean } {
  switch (toolName) {
    case 'read_file': {
      const path = args.path as string;
      const content = MOCK_FILES[path];
      if (content) {
        return {
          content: [{ type: 'text', text: content }],
        };
      }
      return {
        content: [{ type: 'text', text: `Error: File not found: ${path}` }],
        isError: true,
      };
    }

    case 'write_file': {
      const path = args.path as string;
      const fileContent = args.content as string;
      MOCK_FILES[path] = fileContent;
      return {
        content: [{ type: 'text', text: `Successfully wrote ${fileContent.length} bytes to ${path}` }],
      };
    }

    case 'delete_file': {
      const path = args.path as string;
      if (MOCK_FILES[path]) {
        delete MOCK_FILES[path];
        return {
          content: [{ type: 'text', text: `Successfully deleted ${path}` }],
        };
      }
      return {
        content: [{ type: 'text', text: `Error: File not found: ${path}` }],
        isError: true,
      };
    }

    default:
      return {
        content: [{ type: 'text', text: `Unknown tool: ${toolName}` }],
        isError: true,
      };
  }
}

// ── JSON-RPC message handling ───────────────────────────────────────────

function handleMessage(msg: JsonRpcRequest): JsonRpcResponse {
  switch (msg.method) {
    case 'initialize': {
      return {
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: {
            tools: { listChanged: false },
          },
          serverInfo: {
            name: 'eigent-demo-mcp-server',
            version: '1.0.0',
          },
        },
      };
    }

    case 'tools/list': {
      return {
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          tools: TOOLS,
        },
      };
    }

    case 'tools/call': {
      const params = msg.params as { name: string; arguments?: Record<string, unknown> } | undefined;
      if (!params?.name) {
        return {
          jsonrpc: '2.0',
          id: msg.id,
          error: {
            code: -32602,
            message: 'Missing required parameter: name',
          },
        };
      }

      const tool = TOOLS.find((t) => t.name === params.name);
      if (!tool) {
        return {
          jsonrpc: '2.0',
          id: msg.id,
          error: {
            code: -32602,
            message: `Unknown tool: ${params.name}`,
          },
        };
      }

      const result = executeTool(params.name, params.arguments ?? {});
      return {
        jsonrpc: '2.0',
        id: msg.id,
        result,
      };
    }

    case 'notifications/initialized': {
      // Client notification, no response needed
      return {
        jsonrpc: '2.0',
        id: msg.id,
        result: {},
      };
    }

    default: {
      return {
        jsonrpc: '2.0',
        id: msg.id,
        error: {
          code: -32601,
          message: `Method not found: ${msg.method}`,
        },
      };
    }
  }
}

// ── Stdio transport ─────────────────────────────────────────────────────

function send(response: JsonRpcResponse): void {
  const json = JSON.stringify(response);
  process.stdout.write(json + '\n');
}

const rl = createInterface({
  input: process.stdin,
  terminal: false,
});

process.stderr.write('[mock-mcp-server] Started. Listening on stdio...\n');

rl.on('line', (line: string) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  try {
    const msg = JSON.parse(trimmed) as JsonRpcRequest;

    // Skip notifications (no id field)
    if (!('id' in msg)) {
      process.stderr.write(`[mock-mcp-server] Received notification: ${msg.method}\n`);
      return;
    }

    process.stderr.write(`[mock-mcp-server] Received: ${msg.method} (id=${msg.id})\n`);
    const response = handleMessage(msg);
    send(response);
  } catch (err) {
    process.stderr.write(`[mock-mcp-server] Parse error: ${err}\n`);
    send({
      jsonrpc: '2.0',
      id: 0,
      error: { code: -32700, message: 'Parse error' },
    });
  }
});

rl.on('close', () => {
  process.stderr.write('[mock-mcp-server] stdin closed, exiting.\n');
  process.exit(0);
});
