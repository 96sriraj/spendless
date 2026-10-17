/**
 * The primary binding, finally bound: PayPal's own MCP server, behind the port.
 *
 * Every piece this composes was written before the adapter existed — the stdio
 * client, the envelope reader, the token provider, the chunker, the response
 * mapper. This file is deliberately thin, because all the decisions it needs to
 * get right were already made somewhere else and are tested there. What is left
 * is wiring, and wiring is where a seam is either load-bearing or decorative.
 *
 * Two of those decisions are worth restating because they are visible here:
 *
 * - **Chunking is not optional.** PayPal caps a transaction-search window at 31
 *   days and the MCP wrapper clamps silently, so forwarding a 90-day range gets
 *   31 days and no error. `chunkRange` splits, `mergeTransactions` collapses
 *   the boundary duplicates PayPal's undocumented inclusivity produces. Two rows
 *   for one charge would manufacture a cadence that does not exist.
 * - **Capabilities are discovered.** `listTools()` is asked what the server
 *   exposes, and a capability that is absent *throws*. Returning `[]` would tell
 *   the demo "no disputes" when the truth is "cannot see disputes", and that
 *   distinction is the entire reason `capabilities()` is on the port.
 *
 * The dispute lane reports false on purpose, not because the tool is missing
 * from the catalogue but because all three dispute tools call
 * `/v1/customer/disputes` — the buyer's namespace. The live probe returned 200
 * for merchant credentials, which is precisely the trap: reachable is not
 * usable, and this adapter declines to pretend otherwise.
 */

import {
  UnsupportedCapabilityError,
  type AccountCapabilities,
  type AccountSource,
  type DateRange,
  type RawDispute,
  type RawSubscription,
  type RawTransaction,
} from "../AccountSource";
import { chunkRange, mergeTransactions } from "../chunkRange";
import { readTransactions } from "../inspect";
import { readCurrency } from "../inspect";
import type { StdioMcpClient } from "./stdioClient";

/**
 * MCP tool name -> port capability. Membership is the whole mechanism: a
 * capability exists when, and only when, the server exposes the tool behind it.
 */
const TOOL_FOR: Record<keyof AccountCapabilities, string> = {
  listTransactions: "list_transactions",
  listSubscriptions: "list_subscriptions",
  listDisputes: "list_disputes",
  refund: "create_refund",
  cancelSubscription: "cancel_subscription",
  resolveDispute: "accept_dispute_claim",
};

/**
 * Capabilities forced false regardless of what the server exposes.
 *
 * `list_disputes` and `accept_dispute_claim` both route to
 * `/v1/customer/disputes`, which is the buyer's namespace. A merchant reaching
 * it with HTTP 200 is not evidence that it lists disputes *raised against that
 * merchant* — it is evidence that a namespace exists. Reporting these as
 * available would put a merchant dispute view on screen that we cannot stand
 * behind, so the adapter declines even when the tool is right there.
 */
const FORCED_UNAVAILABLE: readonly (keyof AccountCapabilities)[] = [
  "listDisputes",
  "resolveDispute",
];

export function createMcpAccountSource(client: StdioMcpClient): AccountSource {
  /**
   * Cached for the life of the adapter: `tools/list` is a round trip, and a
   * capability check that re-asks per call would put a network call in front of
   * every refusal.
   */
  let toolsPromise: Promise<Set<string>> | null = null;

  function availableTools(): Promise<Set<string>> {
    toolsPromise ??= client.listTools().then((tools) => new Set(tools.map((t) => t.name)));
    return toolsPromise;
  }

  async function capability(key: keyof AccountCapabilities): Promise<boolean> {
    if (FORCED_UNAVAILABLE.includes(key)) return false;
    const tools = await availableTools();
    return tools.has(TOOL_FOR[key]);
  }

  /**
   * Refuse by capability, with the reason in the message.
   *
   * "No disputes" and "cannot see disputes" are different answers and the UI
   * renders them differently, so this never degrades to an empty list.
   */
  async function requireCapability(key: keyof AccountCapabilities): Promise<void> {
    if (await capability(key)) return;
    throw new UnsupportedCapabilityError(
      key,
      "mcp",
      FORCED_UNAVAILABLE.includes(key)
        ? `the server exposes ${TOOL_FOR[key]}, but it routes to /v1/customer/disputes — ` +
          "the buyer's namespace, which does not list claims raised against a merchant"
        : `the server does not expose ${TOOL_FOR[key]}`,
    );
  }

  return {
    kind: "mcp",

    async capabilities(): Promise<AccountCapabilities> {
      // Routed through the same `capability()` the methods use, deliberately.
      // An earlier version re-derived each flag from `tools.has()` and skipped
      // the `FORCED_UNAVAILABLE` override, so `capabilities()` advertised the
      // dispute lanes while `listDisputes()` refused them — the demo would
      // render a button that threw on click. One answer, computed once.
      return {
        listTransactions: await capability("listTransactions"),
        listSubscriptions: await capability("listSubscriptions"),
        listDisputes: await capability("listDisputes"),
        refund: await capability("refund"),
        cancelSubscription: await capability("cancelSubscription"),
        resolveDispute: await capability("resolveDispute"),
      };
    },

    async listTransactions(range: DateRange): Promise<RawTransaction[]> {
      await requireCapability("listTransactions");

      const chunks = chunkRange(range);
      const batches = await Promise.all(
        chunks.map(async (chunk) => {
          const body = await client.callTool("list_transactions", {
            start_date: chunk.start.toISOString(),
            end_date: chunk.end.toISOString(),
            page_size: 100,
          });
          return readTransactions(body);
        }),
      );

      // `mergeTransactions` takes the batches, not a flattened list: collapsing
      // them here would drop the per-chunk boundary that its dedup exists to
      // handle, and the charge that both chunks reported would count twice.
      return mergeTransactions(batches);
    },

    async listSubscriptions(): Promise<RawSubscription[]> {
      await requireCapability("listSubscriptions");
      // `list_subscriptions` returns Billing v1 objects. Mapping them onto
      // RawSubscription is the next piece of work; returning [] here would be a
      // different bug in a different direction, so this throws until it is
      // written rather than answering with a plausible emptiness.
      throw new Error("listSubscriptions mapping is not implemented yet");
    },

    async listDisputes(): Promise<RawDispute[]> {
      await requireCapability("listDisputes");
      return [];
    },
  };
}

/** Re-exported so the executor and the adapter agree on the currency narrowing. */
export { readCurrency };



