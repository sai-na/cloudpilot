/**
 * CloudPilot as a Model Context Protocol server over stdio, so an MCP client
 * (Claude Code, Cursor and others) can call the scanner's read-only lookups.
 *
 * Only what a tools-only stdio server needs is implemented: the handshake,
 * ping, tools/list and tools/call. Messages are JSON-RPC 2.0, one per line.
 * Nothing but protocol messages may be written to the output stream.
 */
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { ToolSpec } from "./advisor.js";

/** Newest first. A client asking for one of these gets it; any other gets the newest. */
const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

/** Every CloudPilot tool only reads, and says so to the client. */
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

export interface McpServerOptions {
  name: string;
  version: string;
  /** Guidance the client passes to its model about how to use these tools. */
  instructions: string;
  tools: ToolSpec[];
  input?: Readable;
  output?: Writable;
}

interface Request {
  jsonrpc?: unknown;
  id?: string | number | null;
  method?: unknown;
  params?: Record<string, unknown>;
}

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

/** Serve until the client closes the input stream. */
export function serveMcp(options: McpServerOptions): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const send = (message: object) => output.write(`${JSON.stringify(message)}\n`);

  async function call(method: string, params: Record<string, unknown>): Promise<object> {
    switch (method) {
      case "initialize": {
        const asked = String(params.protocolVersion ?? "");
        return {
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: options.name, version: options.version },
          instructions: options.instructions,
        };
      }
      case "ping":
        return {};
      case "tools/list":
        return {
          tools: options.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            annotations: READ_ONLY,
          })),
        };
      case "tools/call": {
        const tool = options.tools.find((t) => t.name === params.name);
        if (!tool) throw new RpcError(INVALID_PARAMS, `Unknown tool: ${String(params.name)}`);
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        try {
          return { content: [{ type: "text", text: await tool.run(args) }], isError: false };
        } catch (err) {
          // A tool that fails is a result the model can read and act on, not a protocol error.
          return { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true };
        }
      }
      default:
        throw new RpcError(METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  }

  async function handle(message: Request): Promise<void> {
    const isRequest = message.id !== undefined && message.id !== null;
    if (message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      // Replies to requests we never sent, and anything malformed without an id, are dropped.
      if (isRequest && message.method !== undefined) {
        send({ jsonrpc: "2.0", id: message.id, error: { code: INVALID_REQUEST, message: "Invalid request" } });
      }
      return;
    }
    // Notifications (initialized, cancelled, ...) need no answer.
    if (!isRequest) return;
    try {
      send({ jsonrpc: "2.0", id: message.id, result: await call(message.method, message.params ?? {}) });
    } catch (err) {
      const code = err instanceof RpcError ? err.code : -32603;
      send({ jsonrpc: "2.0", id: message.id, error: { code, message: err instanceof Error ? err.message : String(err) } });
    }
  }

  return new Promise((resolve) => {
    const pending = new Set<Promise<void>>();
    const lines = createInterface({ input, crlfDelay: Infinity });
    lines.on("line", (line) => {
      if (!line.trim()) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        send({ jsonrpc: "2.0", id: null, error: { code: PARSE_ERROR, message: "Parse error" } });
        return;
      }
      // Older protocol versions allow a batch of messages in one line.
      for (const message of Array.isArray(parsed) ? parsed : [parsed]) {
        const work = handle((message ?? {}) as Request).finally(() => pending.delete(work));
        pending.add(work);
      }
    });
    // Let calls that are still running answer before the process ends.
    lines.on("close", () => void Promise.allSettled([...pending]).then(() => resolve()));
  });
}
