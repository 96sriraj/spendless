import { describe, expect, it } from "vitest";
import { createMcpAccountSource } from "./McpPayPalAdapter";
import type { StdioMcpClient } from "./stdioClient";

/**
 * The MCP read path, proven against a recording tool client.
 *
 * Everything here is about the adapter's own decisions — how many calls it
 * makes, which tool it names, what it does with the rows that come back. None
 * of that is PayPal's behaviour, so none of it needs PayPal: the client is a
 * seam (`server.ts` supplies the real one), and these tests hand it a recorder.
 *
 * The properties worth protecting, in the order they have already hurt someone:
 *
 * 1. **Chunking.** PayPal caps a transaction-search window at 31 days and the
 *    MCP wrapper clamps silently. An adapter that forwards a 90-day range gets
 *    31 days and no error, which is a data-loss bug shaped like success.
 * 2. **Not double-counting at the seams.** Chunks share a boundary instant and
 *    PayPal's inclusivity there is undocumented, so the same charge can arrive
 *    twice. Two rows for one charge manufacture a cadence that does not exist.
 * 3. **A capability reported false must throw.** Returning `[]` would tell the
 *    demo "no disputes" when the truth is "cannot see disputes".
 */

type ToolCall = { name: string; args: Record<string, unknown> };

/** One Transaction Search row, shaped like the fields this project reads. */
function transactionRow(overrides: Record<string, unknown> = {}) {
  const info: Record<string, unknown> = {
    transaction_id: "TXN-1",
    transaction_initiation_date: "2026-10-05T12:00:00Z",
    transaction_amount: { currency_code: "USD", value: "15.99" },
    transaction_event_code: "T0006",
    transaction_status: "S",
    transaction_subject: "spendless:sub-netflix",
    ...overrides,
  };
  return { transaction_info: info };
}

function searchResponse(rows: readonly unknown[]) {
  return { transaction_details: rows, account_number: "acct" };
}

/**
 * A tool client that records calls and replies from a per-tool table.
 *
 * Not a mock of the code under test: `stdioClient.callTool` is not what's being
 * examined, it is the adapter's use of it.
 */
function recordingClient(
  replies: Record<string, unknown | ((args: Record<string, unknown>) => unknown)>,
  tools: readonly string[] = ["list_transactions", "list_subscriptions", "list_disputes"],
) {
  const calls: ToolCall[] = [];

  const client: StdioMcpClient = {
    serverInfo: { name: "fixture-paypal", version: "0.0.0" },
    async listTools() {
      return tools.map((name) => ({ name }));
    },
    async callTool(name: string, args: Record<string, unknown> = {}) {
      calls.push({ name, args });
      const reply = replies[name];
      if (reply === undefined) throw new Error(`fixture has no reply for ${name}`);
      return typeof reply === "function" ? reply(args) : reply;
    },
    async close() {
      return undefined;
    },
  };

  return { client, calls, names: () => calls.map((c) => c.name) };
}

const RANGE = {
  start: new Date("2026-01-01T00:00:00Z"),
  end: new Date("2026-04-01T00:00:00Z"), // 90 days
};

describe("McpPayPalAdapter - listTransactions", () => {
  it("asks for 90 days and gets 90 days back, not one capped month", async () => {
    const { client, calls } = recordingClient({
      list_transactions: searchResponse([transactionRow()]),
    });
    const source = createMcpAccountSource(client);

    await source.listTransactions(RANGE);

    // 90 days at a 31-day cap is three calls. One call means the caller got
    // 31 days and believed they had 90.
    expect(calls.length).toBe(3);
    const windows = calls.map((c) => {
      const args = c.args as { start_date?: string; end_date?: string };
      return {
        start: new Date(String(args.start_date)).getTime(),
        end: new Date(String(args.end_date)).getTime(),
      };
    });
    // Contiguous, in order, and covering the caller's range without a gap. A
    // one-millisecond hole would silently drop a charge on the boundary.
    expect(windows[0]?.start).toBe(RANGE.start.getTime());
    expect(windows[windows.length - 1]?.end).toBe(RANGE.end.getTime());
    for (let i = 1; i < windows.length; i += 1) {
      expect(windows[i]?.start).toBe(windows[i - 1]?.end);
    }
  });

  it("never asks for a window wider than PayPal's own limit", async () => {
    const { client, calls } = recordingClient({
      list_transactions: searchResponse([]),
    });
    await createMcpAccountSource(client).listTransactions(RANGE);

    for (const call of calls) {
      const args = call.args as { start_date?: string; end_date?: string };
      const days =
        (new Date(String(args.end_date)).getTime() - new Date(String(args.start_date)).getTime()) /
        86_400_000;
      expect(days).toBeLessThanOrEqual(31);
    }
  });

  it("returns one row for a charge that both of two chunks reported", async () => {
    // The boundary instant is shared, and PayPal's inclusivity there is not
    // documented. Counting it twice inflates the series, and recurrence reads a
    // manufactured cadence as a subscription.
    const boundary = transactionRow({ transaction_id: "TXN-EDGE" });
    const { client } = recordingClient({
      list_transactions: searchResponse([boundary, transactionRow({ transaction_id: "TXN-A" })]),
    });

    const rows = await createMcpAccountSource(client).listTransactions(RANGE);
    const ids = rows.map((r) => r.id);

    expect(ids).toContain("TXN-EDGE");
    expect(ids.filter((id) => id === "TXN-EDGE")).toHaveLength(1);
    expect(rows).toHaveLength(2); // three chunks × two rows, deduplicated
  });

  it("reads identity from the field that survives a round trip", async () => {
    const { client } = recordingClient({
      list_transactions: searchResponse([
        transactionRow({
          // Both documented carriers come back empty from Transaction Search.
          // Measured 2026-10-17; see seedMarker.ts.
          invoice_id: "",
          custom_field: "",
          transaction_subject: "spendless:sub-netflix",
        }),
      ]),
    });

    const [row] = await createMcpAccountSource(client).listTransactions(RANGE);
    expect(row?.merchantKey).toBe("sub-netflix");
    expect(row?.identitySource).toBe("seed_marker");
  });

  it("reports PayPal's own system rows as unknown, never as an identity", async () => {
    // The live T1900 row carries subject="Initial balance". Treating any
    // non-empty subject as an identity produced a false POSITIVE on S-2-live
    // once already, so the marker check is the point of this test.
    const { client } = recordingClient({
      list_transactions: searchResponse([
        transactionRow({
          transaction_id: "T1900",
          transaction_subject: "Initial balance",
          transaction_event_code: "T1900",
        }),
      ]),
    });

    const [row] = await createMcpAccountSource(client).listTransactions(RANGE);
    expect(row?.identitySource).toBe("unknown");
    expect(row?.merchantKey).toBe("unknown");
  });

  it("carries the provider's currency code rather than assuming one", async () => {
    // This account accepts 17 currencies at order creation. Relabelling a EUR
    // row as USD corrupts every figure on screen while looking healthy.
    const { client } = recordingClient({
      list_transactions: searchResponse([
        transactionRow({ transaction_amount: { currency_code: "EUR", value: "9.99" } }),
      ]),
    });

    const [row] = await createMcpAccountSource(client).listTransactions(RANGE);
    expect(row?.currencyCode).toBe("EUR");
    expect(row?.amountCents).toBe(999);
  });
});

describe("McpPayPalAdapter - capabilities", () => {
  it("derives what it can do from the tools the server actually exposes", async () => {
    // Discovered, not assumed. A server that ships without a dispute tool must
    // report that rather than 403-ing on camera.
    const { client } = recordingClient(
      { list_transactions: searchResponse([]) },
      ["list_transactions", "list_subscriptions", "create_refund"],
    );

    expect(await createMcpAccountSource(client).capabilities()).toEqual({
      listTransactions: true,
      listSubscriptions: true,
      listDisputes: false,
      refund: true,
      cancelSubscription: false,
      resolveDispute: false,
    });
  });

  it("reports the dispute lanes unavailable even when the server exposes those tools", async () => {
    // This is the case the live probe created, and it is the one that matters.
    // `list_disputes` and `accept_dispute_claim` are both in the catalogue, and
    // a merchant calling them got HTTP 200 — so tool presence looks like
    // support. It is not: both route to /v1/customer/disputes, the buyer's
    // namespace, which does not list claims raised against a merchant.
    //
    // Deriving this from `tools/list` would put a merchant dispute view on
    // screen that we cannot stand behind. So presence is overridden here, and
    // this test is what keeps the override from being "simplified away".
    const { client } = recordingClient(
      { list_transactions: searchResponse([]) },
      [
        "list_transactions",
        "list_disputes",
        "accept_dispute_claim",
        "create_refund",
        "cancel_subscription",
      ],
    );

    expect(await createMcpAccountSource(client).capabilities()).toEqual({
      listTransactions: true,
      listSubscriptions: false,
      listDisputes: false,
      refund: true,
      cancelSubscription: true,
      resolveDispute: false,
    });
  });
});

describe("McpPayPalAdapter - refusing to pretend", () => {
  it("throws rather than returning no disputes", async () => {
    const { client } = recordingClient(
      { list_transactions: searchResponse([]) },
      ["list_transactions"],
    );
    const source = createMcpAccountSource(client);

    await expect(source.listDisputes()).rejects.toThrow(/cannot listDisputes/i);
    // And it is a typed error, so a caller can branch on the capability rather
    // than on a message string.
    await expect(source.listDisputes()).rejects.toMatchObject({
      name: "UnsupportedCapabilityError",
      capability: "listDisputes",
      adapter: "mcp",
    });
  });

  it("throws rather than returning no subscriptions when the tool is absent", async () => {
    const { client } = recordingClient(
      { list_transactions: searchResponse([]) },
      ["list_transactions"],
    );
    await expect(createMcpAccountSource(client).listSubscriptions()).rejects.toThrow(
      /cannot listSubscriptions/i,
    );
  });

  it("says why the dispute lane is closed, not merely that it is", async () => {
    // The operator reading this needs to distinguish "PayPal took it away" from
    // "we refuse because it is the wrong namespace" — only the second is
    // something a later reader could act on.
    const { client } = recordingClient(
      { list_transactions: searchResponse([]) },
      ["list_transactions", "list_disputes"],
    );

    await expect(createMcpAccountSource(client).listDisputes()).rejects.toThrow(
      /customer\/disputes/i,
    );
  });
});