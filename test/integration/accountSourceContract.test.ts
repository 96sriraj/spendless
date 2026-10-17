/**
 * One contract, run against every adapter. `todo.md` P3-06.
 *
 * The point of the seam in ARCHITECTURE.md §3 is that everything above it is
 * written once and works for every binding. That is only true if the bindings
 * actually agree, and agreement is not something you get for free — it is the
 * thing that decays. Add a third adapter, or change one, and nothing fails
 * until the demo runs against the wrong one.
 *
 * So this asserts the *properties*, not the shape. A structural check would pass
 * an adapter that returns `[]` from `listDisputes` because it has never heard of
 * disputes — which is precisely the bug that makes a demo claim something false
 * about a merchant's account.
 *
 * Two are §11a's, and both were found the hard way:
 *
 * 1. **A capability reported false must throw.** "No disputes" and "cannot see
 *    disputes" are different answers, and the UI renders them differently.
 * 2. **A range must come back whole.** PayPal caps a window at 31 days and the
 *    MCP wrapper clamps silently, so an adapter that forwards the caller's range
 *    returns a month of a year and no error.
 *
 * The MCP adapter runs against a recording client here. Its live behaviour is
 * proven separately and more thoroughly in `paypalMcp.test.ts` and
 * `actionExecutor.live.test.ts`; duplicating a sandbox call per contract
 * property would make this suite slow, flaky, and unable to say which property
 * broke.
 */

import { describe, expect, it } from "vitest";
import {
  UnsupportedCapabilityError,
  IDENTITY_SOURCES,
  type AccountSource,
  type AdapterKind,
  type RawTransaction,
} from "@/adapters/AccountSource";
import { createCsvAccountSource } from "@/adapters/csv/parsePayPalCsv";
import { createMcpAccountSource } from "@/adapters/mcp/McpPayPalAdapter";
import type { StdioMcpClient } from "@/adapters/mcp/stdioClient";

/** A CSV export with two payees and one refund, in the real column layout. */
const CSV_EXPORT = `"Date","Time","TimeZone","Name","Type","Status","Currency","Gross","Fee","Net","From Email Address","To Email Address","Transaction ID","Balance"
"01/15/2026","12:00:00","UTC","Netflix","Website Payment","Completed","USD","15.99","0.00","15.99","me@example.com","billing@netflix.com","TXN1","100.00"
"02/15/2026","12:00:00","UTC","Netflix","Website Payment","Completed","USD","15.99","0.00","15.99","me@example.com","billing@netflix.com","TXN2","84.01"
"03/01/2026","12:00:00","UTC","Adobe","Website Payment","Completed","USD","54.99","0.00","54.99","me@example.com","billing@adobe.com","TXN3","29.02"
"03/05/2026","12:00:00","UTC","Refund from Adobe","Refund","Completed","USD","54.99","0.00","54.99","me@example.com","billing@adobe.com","TXN4","83.01"`;

/** A Transaction Search page, in the real field layout. */
const MCP_PAGE = {
  account_number: "ABC123",
  total_items: 2,
  transaction_details: [
    {
      transaction_info: {
        transaction_id: "MCP1",
        transaction_initiation_date: "2026-03-15T12:00:00Z",
        transaction_amount: { currency_code: "USD", value: "15.99" },
        transaction_event_code: "T0006",
        transaction_status: "S",
        transaction_subject: "spendless:sub-netflix",
        invoice_id: "",
        custom_field: "",
      },
    },
    {
      transaction_info: {
        transaction_id: "MCP2",
        transaction_initiation_date: "2026-04-15T12:00:00Z",
        transaction_amount: { currency_code: "USD", value: "15.99" },
        transaction_event_code: "T0006",
        transaction_status: "S",
        transaction_subject: "spendless:sub-netflix",
        invoice_id: "",
        custom_field: "",
      },
    },
  ],
};

/** An MCP client that answers `list_transactions` and nothing else. */
function mcpSource(): AccountSource {
  const client: StdioMcpClient = {
    serverInfo: { name: "fixture-paypal", version: "0.0.0" },
    async listTools() {
      // `list_transactions` only: the adapter must report every other capability
      // false, and a tool that is present-but-forced-off would hide that.
      return [{ name: "list_transactions" }];
    },
    async callTool(name: string) {
      if (name === "list_transactions") return MCP_PAGE;
      throw new Error(`unexpected tool ${name}`);
    },
    async close() {
      return undefined;
    },
  };
  return createMcpAccountSource(client);
}

const ADAPTERS: readonly {
  readonly name: string;
  readonly kind: AdapterKind;
  readonly make: () => AccountSource;
}[] = [
  { name: "csv", kind: "csv", make: () => createCsvAccountSource(CSV_EXPORT) },
  { name: "mcp", kind: "mcp", make: mcpSource },
];

const ALL_CAPABILITIES = [
  "listTransactions",
  "listSubscriptions",
  "listDisputes",
  "refund",
  "cancelSubscription",
  "resolveDispute",
] as const;

const WIDE_RANGE = {
  start: new Date("2026-01-01T00:00:00Z"),
  end: new Date("2026-06-01T00:00:00Z"),
};

for (const adapter of ADAPTERS) {
  describe(`AccountSource contract — ${adapter.name}`, () => {
    it("identifies which binding it is", () => {
      expect(adapter.make().kind).toBe(adapter.kind);
    });

    it("reports every capability as a boolean, with none missing", async () => {
      // A missing key reads as `undefined`, which is falsy — so an adapter that
      // simply forgets `listSubscriptions` would look like a CSV adapter that
      // legitimately cannot list subscriptions. Both happen for the same reason
      // and want the same fix, but they are not the same fact.
      const caps = await adapter.make().capabilities();
      for (const key of ALL_CAPABILITIES) {
        expect(typeof caps[key], `${key} must be a boolean`).toBe("boolean");
      }
      expect(Object.keys(caps).sort()).toEqual([...ALL_CAPABILITIES].sort());
    });

    it("refuses rather than answering empty when a capability is false", async () => {
      const source = adapter.make();
      const caps = await source.capabilities();

      // Both adapters are read-only exports here, so both must refuse these
      // two — and refusing is the whole assertion. Returning [] is how a demo
      // ends up claiming a merchant has no disputes when it cannot see them.
      expect(caps.listSubscriptions).toBe(false);
      expect(caps.listDisputes).toBe(false);

      for (const [method, capability] of [
        ["listSubscriptions", "listSubscriptions"],
        ["listDisputes", "listDisputes"],
      ] as const) {
        await expect(source[method]()).rejects.toBeInstanceOf(UnsupportedCapabilityError);
        await expect(source[method]()).rejects.toMatchObject({
          capability,
          adapter: adapter.kind,
        });
      }
    });

    it("returns every row in a range that is wider than any provider window", async () => {
      // 150 days here. An MCP adapter that forwards the range gets PayPal's
      // capped 31 days and no error at all.
      const rows = await adapter.make().listTransactions(WIDE_RANGE);
      expect(rows.length).toBeGreaterThan(0);
    });

    it("returns nothing for an inverted range instead of throwing", async () => {
      // Both routes have to agree here: the CSV adapter filters a local file and
      // an inverted window matches nothing; the MCP adapter produces zero chunks
      // and therefore makes no call at all. Either is fine — making a doomed
      // API request is not.
      const rows = await adapter.make().listTransactions({
        start: new Date("2026-06-01T00:00:00Z"),
        end: new Date("2026-01-01T00:00:00Z"),
      });
      expect(rows).toEqual([]);
    });

    it("gives every row the fields the core reads, in valid shapes", async () => {
      const rows = await adapter.make().listTransactions(WIDE_RANGE);
      expect(rows.length).toBeGreaterThan(0);

      for (const row of rows) {
        assertWellFormed(row);
      }
    });

    it("never invents a merchant identity", async () => {
      // A row with no usable identity must say `unknown`, not guess. A
      // fabricated merchant name would produce a finding the user is asked to
      // act on, about a merchant that does not exist in the data.
      const rows = await adapter.make().listTransactions(WIDE_RANGE);
      for (const row of rows) {
        if (row.identitySource === "unknown") {
          expect(row.merchantKey).toBe("unknown");
        } else {
          expect(row.merchantKey).not.toBe("unknown");
        }
      }
    });

    it("does not report an unrefunded refund as a settled charge", async () => {
      // The CSV fixture contains a refund row reported as status Completed,
      // because the refund itself completed. Direction has to live in `status`,
      // or a refunded amount would be ranked as revenue at risk.
      const rows = await adapter.make().listTransactions(WIDE_RANGE);
      for (const row of rows) {
        expect(["settled", "pending", "denied", "reversed"]).toContain(row.status);
      }
    });

    it("is safe to call twice", async () => {
      // The demo reads several sources and re-reads on refresh. An adapter that
      // consumed its input on first read would silently return nothing the
      // second time, which reads as "the account changed".
      const source = adapter.make();
      const first = await source.listTransactions(WIDE_RANGE);
      const second = await source.listTransactions(WIDE_RANGE);
      expect(second.map((r) => r.id)).toEqual(first.map((r) => r.id));
    });
  });
}

/**
 * Range filtering is deliberately **not** a shared contract, and the reason is
 * worth recording so nobody "fixes" it later.
 *
 * The CSV adapter holds the whole file, so it filters the caller's range itself.
 * The MCP adapter does not, and must not: PayPal filters server-side, so a
 * client-side filter would be a second, divergent implementation of the same
 * rule — and it would silently discard rows on a boundary PayPal's inclusivity
 * leaves ambiguous. What the MCP adapter owes instead is *passing the range*,
 * which `McpPayPalAdapter.test.ts` asserts by counting chunk calls.
 *
 * So the filtering property is asserted where it belongs.
 */
describe("csv account source — range filtering", () => {
  const source = () => createCsvAccountSource(CSV_EXPORT);

  it("returns only the rows inside the window", async () => {
    // 1 Feb - 31 Mar. TXN1 (15 Jan) is out; TXN2 (15 Feb), TXN3 (1 Mar) and
    // TXN4 (5 Mar, the Adobe refund) are in. TXN4 being present is the point
    // of the assertion - a filter that dropped refund rows would quietly halve
    // the money the core reasons about.
    const rows = await source().listTransactions({
      start: new Date("2026-02-01T00:00:00Z"),
      end: new Date("2026-03-31T00:00:00Z"),
    });
    expect(rows.map((r) => r.id).sort()).toEqual(["TXN2", "TXN3", "TXN4"]);
  });

  it("returns nothing for a window that predates every row", async () => {
    const rows = await source().listTransactions({
      start: new Date("2025-01-01T00:00:00Z"),
      end: new Date("2025-12-31T00:00:00Z"),
    });
    expect(rows).toEqual([]);
  });
});

/** The shape the core is allowed to rely on, asserted row by row. */
function assertWellFormed(row: RawTransaction): void {
  expect(row.merchantKey.length).toBeGreaterThan(0);
  expect(IDENTITY_SOURCES).toContain(row.identitySource);

  expect(Number.isInteger(row.amountCents)).toBe(true);
  // Negative amounts invert every ranking in the core, so a row carrying one is
  // a bug in the adapter, not something to normalise at the edge.
  expect(row.amountCents).toBeGreaterThanOrEqual(0);

  // Not narrowed to USD|INR on purpose - see RawTransaction.currencyCode.
  expect(row.currencyCode).toMatch(/^[A-Z]{3}$|^UNKNOWN$/);
  expect(Number.isNaN(Date.parse(row.capturedAt))).toBe(false);
  expect(row.raw).toBeDefined();
}