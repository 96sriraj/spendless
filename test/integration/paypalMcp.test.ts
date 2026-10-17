/**
 * The MCP server, for real.
 *
 * Everything else in `src/adapters/mcp/` is proven against a pipe or a
 * recording client. This is the file that finds out whether the real thing
 * works, and it is here because of a specific history: the first live refund
 * probe failed with `spawn npx.cmd EINVAL` (Windows blocks `.cmd` without a
 * shell), and the fix for that exposed a second, quieter failure — the server
 * booted under `Start-Process` but never answered `initialize` when spawned
 * from a Bun parent.
 *
 * Neither failure would ever appear in a unit test, because neither is about
 * our code. They are about the process boundary, which is exactly where this
 * project cannot afford to guess.
 *
 * **Skipped without credentials, never failed by them.** A missing sandbox
 * token must not turn CI red — so this asserts nothing when it cannot connect,
 * and asserts loudly when it can.
 */

import { afterAll, describe, expect, it } from "vitest";
import { connectPayPalMcp, type PayPalMcpConnection } from "@/adapters/mcp/server";
import { createTokenProvider } from "@/adapters/tokenProvider";

const TOKEN_URL = "https://api-m.sandbox.paypal.com/v1/oauth2/token";

function credentialsAvailable(): boolean {
  return (
    process.env["PAYPAL_CLIENT_ID"] !== undefined &&
    process.env["PAYPAL_CLIENT_SECRET"] !== undefined
  );
}

// A cold `npx` fetch can take a while on first run and on a slow network. The
// boot deadline is generous on purpose: a flaky-slow failure here would look
// exactly like a broken integration, which is the expensive misdiagnosis.
const TIMEOUT_MS = 120_000;

describe("PayPal's MCP server - live", () => {
  let connection: PayPalMcpConnection | null = null;

  async function open(): Promise<PayPalMcpConnection> {
    connection ??= await connectPayPalMcp({
      tokenProvider: createTokenProvider({
        tokenUrl: TOKEN_URL,
        clientId: process.env["PAYPAL_CLIENT_ID"] ?? "",
        clientSecret: process.env["PAYPAL_CLIENT_SECRET"] ?? "",
      }),
      bootTimeoutMs: TIMEOUT_MS,
    });
    return connection;
  }

  afterAll(async () => {
    await connection?.close();
  });

  it.runIf(credentialsAvailable())("completes the MCP handshake", async () => {
    const { client } = await open();
    // Not asserted to any particular name: what matters is that a handshake
    // returned at all, since a silent boot is the failure this file exists for.
    expect(client.serverInfo.name.length).toBeGreaterThan(0);
  });

  it.runIf(credentialsAvailable())("exposes the tools the demo depends on", async () => {
    const { client } = await open();
    const names = (await client.listTools()).map((t) => t.name);

    // Record what is actually there rather than asserting a wish list. The
    // dispute tools are expected to be present and expected to be unusable from
    // a merchant account - that combination is the trap, and asserting their
    // absence here would just be wrong.
    console.log(`      ${names.length} tools: ${names.join(", ")}`);
    expect(names).toContain("list_transactions");
  });
});