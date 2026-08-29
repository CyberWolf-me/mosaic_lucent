import { BoardSession, listTools, type ToolResult } from "./tools.js";

/**
 * Minimal MCP-over-stdio server. MCP is JSON-RPC 2.0 framed by line-delimited
 * JSON on stdin/stdout, so a dependency-free reader is enough to expose the
 * board tools to any MCP client (Claude Desktop, Cursor, an IDE) without pulling
 * in an SDK. The three methods a client needs are implemented: initialize,
 * tools/list, tools/call.
 */

/** The session contract the dispatcher needs — structural, so the remote session needs no import here. */
interface RemoteBoardSessionLike {
  callTool(name: string, args: Record<string, unknown>): ToolResult | Promise<ToolResult>;
}

interface RpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

const PROTOCOL_VERSION = "2024-11-05";

export function createDispatcher(
  session: Pick<BoardSession | RemoteBoardSessionLike, "callTool"> = new BoardSession(),
) {
  return async function handle(req: RpcRequest): Promise<object | null> {
    const reply = (result: unknown) => ({ jsonrpc: "2.0" as const, id: req.id ?? null, result });
    const fail = (code: number, message: string) => ({
      jsonrpc: "2.0" as const,
      id: req.id ?? null,
      error: { code, message },
    });

    switch (req.method) {
      case "initialize":
        return reply({
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "lucent-mcp", version: "0.0.0" },
        });
      case "notifications/initialized":
        return null; // notification: no response
      case "tools/list":
        return reply({ tools: listTools() });
      case "tools/call": {
        const name = req.params?.name;
        const args = (req.params?.arguments as Record<string, unknown>) ?? {};
        if (typeof name !== "string") return fail(-32602, "tools/call requires a string `name`.");
        // Awaited, not called synchronously: the remote session's tool calls
        // are HTTP round trips. The local session returns plain values, and
        // `await` on a non-promise is a no-op, so both session shapes ride
        // this one line.
        const result: ToolResult = await session.callTool(name, args);
        return reply(result);
      }
      case "ping":
        return reply({});
      default:
        return fail(-32601, `Method not found: ${req.method}`);
    }
  };
}

/**
 * Wire the dispatcher up to stdin/stdout. Runs until stdin closes.
 * `session` selects the backing store: the process-local `BoardSession`
 * default, or a `RemoteBoardSession` for agent access to a live board.
 */
export function serveStdio(
  session: Pick<BoardSession | RemoteBoardSessionLike, "callTool"> = new BoardSession(),
): void {
  const dispatch = createDispatcher(session);
  let buffer = "";

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let req: RpcRequest;
      try {
        req = JSON.parse(line) as RpcRequest;
      } catch {
        process.stdout.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32700, message: "Parse error" },
          }) + "\n",
        );
        continue;
      }
      // The dispatcher is async (the remote session does HTTP), so each
      // request is handled in its own microtask; writes stay ordered because
      // every dispatch resolves before the next line is parsed off the same
      // stdin chunk, and across chunks because Node's stdin emits serially.
      void dispatch(req).then((response) => {
        if (response) process.stdout.write(JSON.stringify(response) + "\n");
      });
    }
  });
}
