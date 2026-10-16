/**
 * A minimal MCP client over stdio.
 *
 * `AGENTS.md` names the in-process MCP server as the primary adapter and makes
 * deleting the other adapters a stated goal — so this is deliberately the *only*
 * place in the codebase that knows JSON-RPC, newline framing, or that PayPal's
 * toolkit speaks MCP at all. Everything above it depends on
 * `AccountSource`/`ActionExecutor` and nothing else.
 *
 * Hand-rolled rather than pulled from the MCP SDK, for one reason: this project
 * cannot afford a dependency that changes shape under it two weeks before a
 * submission, and the protocol surface actually used here is three methods and
 * one tool call. The trade is that the framing has to be right, which is why the
 * tests in `test/integration/stdioClient.test.ts` spawn a **real** server
 * process rather than stubbing the transport.
 *
 * The failure modes this exists to prevent, in order of how quietly they fail:
 *
 * 1. A wedged server producing silence. Hence a timeout on every call, and on
 *    the handshake.
 * 2. Out-of-order responses being handed to the wrong caller. Hence matching on
 *    request id, never on arrival order — otherwise one merchant's transactions
 *    get attributed to another, which is the worst bug this project could ship.
 * 3. A call made after close hanging on a dead pipe. Hence an explicit closed
 *    check that rejects.
 */

import { readMcpToolResult } from "./mcpEnvelope";

export type McpToolDescriptor = {
  readonly name: string;
  readonly description?: string;
};

export type StdioMcpClientOptions = {
  /** An already-spawned child. Spawning is the caller's decision, not ours. */
  readonly spawn: {
    stdin: { write(chunk: string): unknown };
    stdout: { on(event: "data", listener: (chunk: unknown) => void): unknown };
    stderr?: { on(event: "data", listener: (chunk: unknown) => void): unknown };
    /**
     * Optional so a test can hand over a hand-rolled transport, and narrow
     * enough to accept a real `ChildProcess`. Node types `kill`'s signal as
     * `number | Signals`, so this cannot simply be Node's own signature.
     */
    kill?(signal?: unknown): unknown;
  };
  /** Fail the handshake rather than wait forever for a server that never boots. */
  readonly bootTimeoutMs?: number;
  /** Per-call timeout. A missing default here is a hung demo. */
  readonly defaultTimeoutMs?: number;
};

export type StdioMcpClient = {
  readonly serverInfo: { readonly name: string; readonly version: string };
  listTools(): Promise<McpToolDescriptor[]>;
  /**
   * Call a tool and return its **unwrapped payload**.
   *
   * Unwrapping happens here rather than at each call site, deliberately. The
   * envelope hides a tool-reported failure behind `isError: true`, so a caller
   * that forgets to check it treats an error object as data — which is the
   * silent-empty-result failure this whole module exists to prevent. Making it
   * impossible to forget is worth more than the one extra line it saves.
   *
   * @throws `McpToolError` when the tool reported a failure, when the envelope
   *   carried no text block, or when the text was not JSON.
   */
  callTool(
    name: string,
    args?: Record<string, unknown>,
    options?: { timeoutMs?: number },
  ): Promise<unknown>;
  close(): Promise<void>;
};

const PROTOCOL_VERSION = "2024-11-05";
const DEFAULT_TIMEOUT_MS = 30_000;

type Pending = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class McpTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpTransportError";
  }
}

export function createStdioMcpClient(
  options: StdioMcpClientOptions,
): Promise<StdioMcpClient> {
  const child = options.spawn;
  const defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;

  const pending = new Map<number, Pending>();
  let nextId = 1;
  let closed = false;
  let buffer = "";

  /** Stderr is only worth surfacing on a failure, so it is kept, not printed. */
  let stderrTail = "";

  function failAll(reason: Error): void {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(reason);
    }
    pending.clear();
  }

  child.stderr?.on("data", (chunk: unknown) => {
    stderrTail = `${stderrTail}${String(chunk)}`.slice(-2_000);
  });

  child.stdout.on("data", (chunk: unknown) => {
    buffer += String(chunk);

    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");

      if (line.length === 0) continue;

      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        // Non-JSON on stdout means the framing is wrong or the process is not
        // an MCP server. Either way every outstanding call is unanswerable.
        failAll(
          new McpTransportError(
            `MCP server wrote a line that is not JSON-RPC: ${line.slice(0, 120)}${stderrSuffix()}`,
          ),
        );
        return;
      }

      const id = message["id"];
      if (typeof id !== "number") continue; // a notification or a server request
      const entry = pending.get(id);
      if (entry === undefined) continue; // a response to a call we already timed out
      pending.delete(id);
      clearTimeout(entry.timer);

      const error = message["error"];
      if (error !== undefined && error !== null) {
        const detail = (error as { message?: unknown }).message;
        entry.reject(
          new McpTransportError(
            `MCP call failed${typeof detail === "string" ? `: ${detail}` : ""}`,
          ),
        );
        continue;
      }
      entry.resolve(message["result"]);
    }
  });

  function stderrSuffix(): string {
    return stderrTail.trim().length > 0 ? ` (stderr: ${stderrTail.trim().slice(-200)})` : "";
  }

  function request(
    method: string,
    params: Record<string, unknown> | undefined,
    timeoutMs: number,
  ): Promise<unknown> {
    if (closed) {
      return Promise.reject(new McpTransportError(`MCP client is closed; cannot call ${method}`));
    }

    const id = nextId++;
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      ...(params === undefined ? {} : { params }),
    });

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(
          new McpTransportError(
            `MCP ${method} timed out after ${timeoutMs}ms with no response${stderrSuffix()}`,
          ),
        );
      }, timeoutMs);

      pending.set(id, { resolve, reject, timer });

      try {
        child.stdin.write(`${payload}\n`);
      } catch (cause) {
        clearTimeout(timer);
        pending.delete(id);
        reject(new McpTransportError(`could not write to MCP server: ${String(cause)}`));
      }
    });
  }

  const bootPromise = request(
    "initialize",
    {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "spendless", version: "0.1.0" },
    },
    options.bootTimeoutMs ?? defaultTimeoutMs,
  );

  return bootPromise.then((result) => {
    const info = (result as { serverInfo?: { name?: string; version?: string } }).serverInfo;

    return {
      serverInfo: {
        name: info?.name ?? "unknown",
        version: info?.version ?? "unknown",
      },

      async listTools(): Promise<McpToolDescriptor[]> {
        const listed = await request("tools/list", {}, defaultTimeoutMs);
        const tools = (listed as { tools?: unknown }).tools;
        if (!Array.isArray(tools)) return [];
        return tools
          .filter(
            (tool): tool is { name: string; description?: string } =>
              typeof tool === "object" &&
              tool !== null &&
              typeof (tool as { name?: unknown }).name === "string",
          )
          .map((tool) => ({
            name: tool.name,
            ...(typeof tool.description === "string" ? { description: tool.description } : {}),
          }));
      },

      callTool(
        name: string,
        args: Record<string, unknown> = {},
        callOptions: { timeoutMs?: number } = {},
      ): Promise<unknown> {
        return request(
          "tools/call",
          { name, arguments: args },
          callOptions.timeoutMs ?? defaultTimeoutMs,
        ).then((result) => readMcpToolResult(result, name));
      },

      async close(): Promise<void> {
        if (closed) return;
        closed = true;
        failAll(new McpTransportError("MCP client closed"));
        child.kill?.();
      },
    };
  });
}
