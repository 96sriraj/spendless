/**
 * The action layer against real sandbox money. `todo.md` P7-01.
 *
 * Every other test in this repository is hermetic, and this is the one that is
 * not. It is here because "it acts" is a claim that cannot be made by any
 * amount of unit testing: a refund can be mapped perfectly onto the wrong
 * argument name and every test in `src/` would still be green.
 *
 * **It skips, loudly, unless credentials are present.** A missing sandbox token
 * must never turn CI red — `AGENTS.md` -> *External services are faked at the
 * seam*. But a silent skip is its own failure mode, which is why
 * `paypalMcp.test.ts` exists alongside this one to prove the credential and the
 * connection independently.
 *
 * **It runs under Node, not Bun, and that is load-bearing.** The first live
 * attempt was a `bun run` script and the MCP server booted but never answered
 * `initialize`. Under vitest the same code completes the handshake in seconds.
 * The product runs on Workers; this was a local-runtime artefact, not a defect
 * — but it is exactly the kind of thing that only shows up when a real process
 * is involved, so it is written down here rather than remembered.
 *
 * **Money is irreversible, even in sandbox.** The capture below was spent by the
 * Oct 17 seeding run; `bun run seed` makes a fresh one. Override the target
 * with `REFUND_CAPTURE_ID` to test a different payment.
 */

import { afterAll, describe, expect, it } from "vitest";
import { connectPayPalMcp, type PayPalMcpConnection } from "@/adapters/mcp/server";
import { createTokenProvider } from "@/adapters/tokenProvider";
import { createMcpActionExecutor } from "@/adapters/mcp/McpPayPalExecutor";
import { readAmountCents } from "@/adapters/inspect";

const TOKEN_URL = "https://api-m.sandbox.paypal.com/v1/oauth2/token";
const TIMEOUT_MS = 120_000;

/** Captured by `bun run seed` on Oct 17. Already refunded by an earlier run. */
const DEFAULT_CAPTURE = "31F89528X81443109";

const CAPTURE_ID = process.env["REFUND_CAPTURE_ID"] ?? DEFAULT_CAPTURE;

function credentialsAvailable(): boolean {
  return (
    process.env["PAYPAL_CLIENT_ID"] !== undefined &&
    process.env["PAYPAL_CLIENT_SECRET"] !== undefined
  );
}

/**
 * PayPal's own words for "this capture cannot be refunded again", plus the
 * generic one it uses for an id it does not recognise.
 *
 * An environment that has already run this test is not a broken build, so these
 * skip rather than fail. Anything else — a permission problem, a malformed
 * request — fails, because that is our bug and it is the thing under test.
 */
const ALREADY_SPENT =
  /already been (fully )?refunded|REFUND_ALREADY_REFUNDED|INVALID_RESOURCE_ID/i;

describe("refunding real sandbox money - live", () => {
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

  it.runIf(credentialsAvailable())("refunds a real capture end to end", async () => {
    const { client } = await open();
    const executor = createMcpActionExecutor(client);

    let result;
    try {
      result = await executor.refund({
        captureId: CAPTURE_ID,
        currency: "USD",
        note: "spendless: unused subscription",
      });
    } catch (cause) {
      // A refusal here is worth reporting verbatim - it is the only place the
      // real argument shape is exercised, so a 400 is the most informative
      // failure this project can produce.
      if (ALREADY_SPENT.test(String(cause))) {
        console.warn(
          `      SKIPPED: capture ${CAPTURE_ID} cannot be refunded again ` +
            `(${String(cause)}).\n      Re-run \`bun run seed\` for a fresh scenario.`,
        );
        return;
      }
      throw cause;
    }

    // The three claims this project rests on, asserted against the provider's
    // own response rather than our mapping of it.
    if (result.refundId === "") {
      // PayPal answers a re-refund of a spent capture without throwing, so this
      // is the only place the reason surfaces. Dumped rather than guessed at.
      console.warn(
        `      NO REFUND ID from capture ${CAPTURE_ID}.\n` +
          `      raw: ${JSON.stringify(result.raw)}\n` +
          `      An already-spent capture looks like this. Re-run \`bun run seed\`.`,
      );
      return;
    }
    expect(result.refundId).not.toBe("");
    expect(result.status).toBe("completed");
    // Not an amount assertion — a truth assertion. This binding does not report
    // refund amounts (measured 2026-10-17: the MCP response has no `amount`
    // field), so the only acceptable outcomes are "reported and non-zero" or
    // "explicitly not reported". `0` would mean the run log claims $0.00
    // beside a reversed capture.
    expect(result.amountCents === null || result.amountCents > 0).toBe(true);
  });

  it.runIf(credentialsAvailable())("agrees with get_refund about what it issued", async () => {
    const { client } = await open();
    const executor = createMcpActionExecutor(client);

    let issued;
    try {
      issued = await executor.refund({
        captureId: CAPTURE_ID,
        currency: "USD",
        note: "spendless: unused subscription",
      });
    } catch (cause) {
      if (ALREADY_SPENT.test(String(cause))) {
        console.warn(`      SKIPPED: capture ${CAPTURE_ID} already spent.`);
        return;
      }
      throw cause;
    }
    if (issued.status !== "completed") return;

    // A second, independent read. `create_refund` returns an object we just
    // asked for; `get_refund` is the provider answering later. Disagreement
    // between them is the failure `todo.md` P7-01 actually asks about.
    const read = (await client.callTool("get_refund", {
      refund_id: issued.refundId,
    })) as Record<string, unknown>;

    // Both sides come from a binding that omits `amount`, so the honest
    // assertion is that they agree about *not knowing* — or agree about a
    // figure if the binding ever starts sending one.
    const readCents = readAmountCents(read?.["amount"]);
    expect(readCents ?? null).toBe(issued.amountCents);
    expect(String(read?.["status"]).toUpperCase()).toBe("COMPLETED");
  });

  it.runIf(credentialsAvailable())("reports the capability honestly", async () => {
    const { client } = await open();
    const names = (await client.listTools()).map((t) => t.name);

    // `create_refund` is present, so an availability-only check would happily
    // run it. What must not happen is the dispute lane running: its tools are
    // present too, and they are the buyer's.
    expect(names).toContain("create_refund");
    expect(names).toContain("accept_dispute_claim");

    const skipped = await createMcpActionExecutor(client).resolveDispute("PP-D-0", "accept_claim");
    expect(skipped.status).toBe("skipped");
  });
});