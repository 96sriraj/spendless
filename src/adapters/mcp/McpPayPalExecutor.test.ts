import { describe, expect, it } from "vitest";
import { createMcpActionExecutor } from "./McpPayPalExecutor";
import type { StdioMcpClient } from "./stdioClient";

/**
 * The money-moving side, proven against a recording tool client.
 *
 * These are the highest-consequence tests in the repository: everything else
 * here can be wrong on a screen, and this can be wrong in someone's account.
 * So the tests are less about mapping and more about what the executor refuses.
 *
 * The properties, in order of how much damage each would do:
 *
 * 1. **A refusal must never become a silent no-op.** If the server has no
 *    `create_refund`, returning `status: "skipped"` would render as a completed
 *    proposal with nothing behind it. It throws.
 * 2. **A failed refund must not read as a successful one.** The run log is the
 *    demo's evidence, so a provider-reported failure has to survive into the
 *    result rather than being flattened into a status the UI will happily
 *    render as green.
 * 3. **The amount is ours, not PayPal's echo.** The result carries the amount
 *    the caller asked for, and the cap in `refund()` is the whole reason the
 *    amount is passed explicitly rather than defaulted.
 */

type ToolCall = { name: string; args: Record<string, unknown> };

function recordingClient(replies: Record<string, unknown | (() => unknown)>) {
  const calls: ToolCall[] = [];
  const client: StdioMcpClient = {
    serverInfo: { name: "fixture-paypal", version: "0.0.0" },
    async listTools() {
      return Object.keys(replies).map((name) => ({ name }));
    },
    async callTool(name: string, args: Record<string, unknown> = {}) {
      calls.push({ name, args });
      const reply = replies[name];
      if (reply === undefined) throw new Error(`fixture has no reply for ${name}`);
      return typeof reply === "function" ? reply() : reply;
    },
    async close() {
      return undefined;
    },
  };
  return { client, calls };
}

const CAPTURE = "31F89528X81443109";

/** A completed refund, shaped like PayPal's `Refund` object. */
const REFUND_OK = {
  id: "1JU089403K556124",
  status: "COMPLETED",
  amount: { currency_code: "USD", value: "15.99" },
  invoice_number: "spendless-sub-netflix",
  note_to_payer: "unused",
};

describe("McpPayPalExecutor - refund", () => {
  it("issues the refund and reports what PayPal actually did", async () => {
    const { client, calls } = recordingClient({ create_refund: REFUND_OK });

    const result = await createMcpActionExecutor(client).refund({
      captureId: CAPTURE,
      amountCents: 1599,
      currency: "USD",
      note: "unused",
    });

    expect(calls).toEqual([
      { name: "create_refund", args: expect.objectContaining({ capture_id: CAPTURE }) },
    ]);
    expect(result.refundId).toBe("1JU089403K556124");
    expect(result.status).toBe("completed");
    expect(result.amountCents).toBe(1599);
  });

  it("sends the amount when it is a partial refund, and omits it for a full one", async () => {
    // Omitting `amount` means "refund the capture in full" to PayPal. Sending a
    // stray zero or the full amount when a partial was asked for is how a
    // partial refund becomes a total one.
    const { client, calls } = recordingClient({ create_refund: REFUND_OK });
    const executor = createMcpActionExecutor(client);

    await executor.refund({ captureId: CAPTURE, currency: "USD", note: "full" });
    await executor.refund({ captureId: CAPTURE, amountCents: 500, currency: "USD", note: "part" });

    const args = calls.map((c) => c.args as Record<string, unknown>);
    expect(args[0]?.["amount"]).toBeUndefined();
    expect(args[1]?.["amount"]).toBeDefined();
  });

  it("reports a provider-reported failure as failed, never as completed", async () => {
    // `stdin` calls can come back HTTP 201 with status PENDING, or an error
    // body with a 200. Both are the provider refusing, and the run log is the
    // demo's evidence - a failure flattened into "skipped" would render green.
    const { client } = recordingClient({
      create_refund: {
        id: "1JU-FAILED",
        status: "FAILED",
        amount: { currency_code: "USD", value: "15.99" },
      },
    });

    const result = await createMcpActionExecutor(client).refund({
      captureId: CAPTURE,
      currency: "USD",
      note: "unused",
    });

    expect(result.status).toBe("failed");
  });

  it("throws rather than reporting success when the server cannot refund at all", async () => {
    const { client } = recordingClient({ list_transactions: {} });
    const executor = createMcpActionExecutor(client);

    // A missing create_refund must not become status "skipped". The action
    // layer's whole job is to distinguish "did it" from "did not do it".
    await expect(
      executor.refund({ captureId: CAPTURE, currency: "USD", note: "unused" }),
    ).rejects.toThrow(/cannot refund/i);
    await expect(
      executor.refund({ captureId: CAPTURE, currency: "USD", note: "unused" }),
    ).rejects.toMatchObject({ capability: "refund", adapter: "mcp" });
  });
});

describe("McpPayPalExecutor - cancellation", () => {
  it("cancels a live subscription and reports the provider reference", async () => {
    const { client, calls } = recordingClient({
      cancel_subscription: { id: "I-BW452GLLEP1G", status: "Cancelled" },
    });

    const result = await createMcpActionExecutor(client).cancelSubscription("I-BW452GLLEP1G");

    expect(calls[0]?.name).toBe("cancel_subscription");
    expect(result.status).toBe("succeeded");
    expect(result.providerRef).toBe("I-BW452GLLEP1G");
  });

  it("throws rather than reporting a skip when cancellation is unavailable", async () => {
    const { client } = recordingClient({ create_refund: REFUND_OK });
    await expect(createMcpActionExecutor(client).cancelSubscription("I-1")).rejects.toThrow(
      /cannot cancelSubscription/i,
    );
  });
});

describe("McpPayPalExecutor - the dispute lane", () => {
  it("reports a merchant dispute move as unsupported even when the tool exists", async () => {
    // `accept_dispute_claim` is in the catalogue and answers 200 for merchant
    // credentials - but it pays money *back to the buyer*, in the buyer's
    // namespace. Reporting it as supported would put an unreviewed payout on
    // screen that we cannot show the merchant the correct counterpart of.
    const { client } = recordingClient({ accept_dispute_claim: { status: "OK" } });
    const executor = createMcpActionExecutor(client);

    const result = await executor.resolveDispute("PP-D-1", "accept_claim");

    expect(result.status).toBe("skipped");
    expect(result.message).toMatch(/customer\/disputes|merchant/i);
    expect(result.message).not.toMatch(/^$/);
  });

  it("does not call any dispute tool, because the namespace is the buyer's", async () => {
    const { client, calls } = recordingClient({ accept_dispute_claim: { status: "OK" } });
    await createMcpActionExecutor(client).resolveDispute("PP-D-1", "offer");
    expect(calls).toHaveLength(0);
  });
});