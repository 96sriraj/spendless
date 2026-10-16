import { afterEach, describe, expect, it } from "vitest";
import { createStdioMcpClient } from "@/adapters/mcp/stdioClient";

/**
 * The stdio transport, against a real MCP server process.
 *
 * The alternative was a hand-rolled mock of the transport, which would have
 * proved that a fake returns what the fake was told to return. Spawning a real
 * child process and speaking real JSON-RPC over its pipes is the only way to
 * find out whether the framing is right — and framing is exactly what goes
 * wrong silently in a stdio client (a missing newline, a message split across
 * two chunks, a response id that never gets matched).
 *
 * **What is deliberately *not* here:** response-to-caller matching. That case
 * originally lived in this file and needed a sleep plus a losing race to
 * manufacture the reordering — it passed alone and failed in the full suite
 * roughly half the time. It is a pure bookkeeping property, so it now lives in
 * `src/adapters/mcp/stdioClient.dispatch.test.ts` against a fake pipe, where it
 * is deterministic. This file keeps only what genuinely needs a process:
 * handshake, tool discovery, argument round-trip, in-band tool errors, a call
 * that is never answered, non-JSON on stdout, and calls after close.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";

/** A real MCP server over stdio, implementing `initialize` and two tools. */
function writeServer(): string {
  return `
const pending = new Map();
let buffer = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\\n")) !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line.length === 0) continue;
    const message = JSON.parse(line);


    if (message.id === undefined) continue; // notification
    const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");

    if (message.method === "initialize") {
      reply({
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "fixture-paypal", version: "0.0.0" },
      });
      return;
    }
    if (message.method === "tools/list") {
      reply({
        tools: [
          { name: "list_transactions", description: "wrapped Transaction Search v1", inputSchema: { type: "object" } },
          { name: "list_disputes", description: "buyer namespace", inputSchema: { type: "object" } },
        ],
      });
      return;
    }
    if (message.method === "tools/call") {
      const name = message.params?.name;
      const args = message.params?.arguments ?? {};
      const send = (payload, isError = false) => reply({
        content: [{ type: "text", text: JSON.stringify(payload) }],
        isError,
      });

      if (name === "list_transactions") {
        send({
          transaction_details: [
            {
              transaction_info: {
                transaction_id: args.expected_id ?? "31F89528X81443109",
                transaction_event_code: "T0000",
                transaction_amount: { currency_code: "USD", value: "15.99" },
                transaction_initiation_date: "2026-10-17T02:20:00+0000",
                transaction_status: "S",
                invoice_id: "sub-netflix",
                custom_field: "sub-netflix",
              },
            },
          ],
        });
        return;
      }
      if (name === "list_disputes") {
        send({ items: [{ dispute_id: "PP-D-1", status: "OPEN" }] });
        return;
      }
      if (name === "explode") {
        send({ error: "invalid_client", message: "bad creds" }, true);
        return;
      }
      if (name === "hang") { return; } // never replies
      if (name === "garbage") {
        process.stdout.write("this is not json\\n");
        return;
      }
      reply({ content: [{ type: "text", text: JSON.stringify({ error: "unknown tool" }) }], isError: true });
      return;
    }
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: "Method not found" },
    }) + "\\n");
  }
});
`;
}

const BOOT = 10_000;
/**
 * Short enough that a hung call fails in seconds rather than the 30s default,
 * long enough that a loaded machine spawning a process is not a failure.
 */
const CALL_TIMEOUT = 8_000;

describe("createStdioMcpClient", () => {
  const children: ChildProcessWithoutNullStreams[] = [];

  afterEach(async () => {
    for (const child of children.splice(0)) {
      // `close()` in a test's `finally` has usually already killed this child.
      // `once(child, "exit")` registered *after* the fact never settles, so
      // awaiting it unconditionally hangs the hook and eats the suite's budget.
      // Check first, and only wait when the process is genuinely still alive.
      if (child.exitCode !== null || child.signalCode !== null) continue;
      const exited = once(child, "exit");
      child.kill();
      await exited.catch(() => undefined);
    }
  });

  async function start(): Promise<ReturnType<typeof createStdioMcpClient>> {
    const child = spawn(process.execPath, ["-e", writeServer()], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(child);
    return createStdioMcpClient({
      spawn: child,
      bootTimeoutMs: BOOT,
      defaultTimeoutMs: CALL_TIMEOUT,
    });
  }

  it("should complete the handshake and report the server's identity", async () => {
    const client = await start();
    try {
      expect(client.serverInfo.name).toBe("fixture-paypal");
    } finally {
      await client.close();
    }
  });

  it("should list the tools the server advertises", async () => {
    // Capability discovery is the point: `capabilities()` on AccountSource is
    // meant to be asked, not assumed, so the adapter has to be able to read
    // this list.
    const client = await start();
    try {
      expect((await client.listTools()).map((t) => t.name)).toEqual([
        "list_transactions",
        "list_disputes",
      ]);
    } finally {
      await client.close();
    }
  });

  it("should send arguments and return the parsed payload", async () => {
    const client = await start();
    try {
      const body = (await client.callTool("list_transactions", { expected_id: "ABC123" })) as {
        transaction_details: { transaction_info: { transaction_id: string } }[];
      };

      // Proves both directions: arguments reached the server, and the response
      // came back unwrapped from the envelope rather than as a raw string.
      expect(body.transaction_details[0]?.transaction_info.transaction_id).toBe("ABC123");
    } finally {
      await client.close();
    }
  });

  it("should reject with the server's message when the tool reports an error", async () => {
    const client = await start();
    try {
      await expect(client.callTool("explode")).rejects.toThrow(/invalid_client|bad creds/);
    } finally {
      await client.close();
    }
  });

  it("should reject rather than hang when the server never answers", async () => {
    // The failure this whole client exists to prevent: a wedged MCP server
    // turning into a wedged demo with no output and no explanation.
    const client = await start();
    try {
      await expect(client.callTool("hang", {}, { timeoutMs: 300 })).rejects.toThrow(
        /timed out|no response/i,
      );
    } finally {
      await client.close();
    }
  });

  it("should reject when the server writes something that is not JSON-RPC", async () => {
    const client = await start();
    try {
      await expect(client.callTool("garbage", {}, { timeoutMs: 2_000 })).rejects.toThrow();
    } finally {
      await client.close();
    }
  });

  it("should reject a call to a tool the server does not have", async () => {
    const client = await start();
    try {
      await expect(client.callTool("nonexistent")).rejects.toThrow();
    } finally {
      await client.close();
    }
  });

  it("should stop accepting calls once closed, rather than hanging on a dead pipe", async () => {
    const client = await start();
    await client.close();

    await expect(client.listTools()).rejects.toThrow(/closed/i);
  });
});
