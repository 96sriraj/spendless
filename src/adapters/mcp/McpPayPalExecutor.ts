/**
 * The first code in this repository that can move money.
 *
 * Everything else here is reversible — a wrong merchant key shows up as a wrong
 * graph, a wrong currency shows up as a wrong number. This is the layer where a
 * mistake is irreversible, so it is written to be uninteresting to use and hard
 * to misuse:
 *
 * - **A missing capability throws.** It does not return `status: "skipped"`,
 *   because the action layer's entire job is telling "did it" apart from "did
 *   not do it", and a refusal that renders as a completed proposal is the one
 *   failure that makes the run log a lie.
 * - **A provider failure stays a failure.** PayPal can answer HTTP 201 with
 *   `status: "FAILED"`, and an error body with a 200. Both are refusals, and
 *   neither is flattened into something the UI will paint green.
 * - **The amount is sent only when it is a partial refund.** Omitting it means
 *   "refund the capture in full" to PayPal, so a zero or a stray full amount on
 *   a partial request is how a partial refund becomes a total one.
 * - **Disputes are declined structurally.** `accept_dispute_claim` is in the
 *   catalogue and answered 200 for merchant credentials, but it pays money back
 *   to the buyer in the buyer's namespace. This returns `skipped` with a reason
 *   and calls nothing, because "the tool exists" and "this is a merchant
 *   operation" are different claims and only the second one makes it an action.
 *
 * Note what is *not* here: the refund cap. That belongs to the action layer
 * (`todo.md` P6-03), above this seam, and a guardrail duplicated down here would
 * be a second place to forget it. This executor issues what it is asked to
 * issue; the decision to ask is not its job.
 */

import {
  UnsupportedCapabilityError,
  type ActionExecutor,
  type ActionResult,
  type DisputeMove,
  type RefundInput,
  type RefundResult,
} from "../AccountSource";
import { readAmountCents } from "../inspect";
import type { StdioMcpClient } from "./stdioClient";

/** MCP tool name -> the port capability that authorises it. */
const TOOL_FOR: Record<"refund" | "cancelSubscription" | "resolveDispute", string> = {
  refund: "create_refund",
  cancelSubscription: "cancel_subscription",
  resolveDispute: "accept_dispute_claim",
};

/** PayPal's own refund statuses, reduced to the three the port carries. */
const REFUND_STATUS: Record<string, RefundResult["status"]> = {
  COMPLETED: "completed",
  PENDING: "pending",
};

const DISPUTE_LANE_CLOSED =
  "accept_dispute_claim routes to /v1/customer/disputes — the buyer's namespace. " +
  "It answers 200 for merchant credentials, but it pays money back to the buyer " +
  "and does not expose claims raised against this merchant, so it is not a " +
  "merchant action. Cut rather than faked.";

export function createMcpActionExecutor(client: StdioMcpClient): ActionExecutor {
  let toolsPromise: Promise<Set<string>> | null = null;

  function availableTools(): Promise<Set<string>> {
    toolsPromise ??= client.listTools().then((tools) => new Set(tools.map((t) => t.name)));
    return toolsPromise;
  }

  /**
   * Refuse before doing anything, naming the tool that is missing.
   *
   * Checked up front rather than by catching a later error, because a refusal
   * and a failure look identical in a run log unless one of them says so.
   */
  async function requireTool(
    key: "refund" | "cancelSubscription" | "resolveDispute",
  ): Promise<void> {
    const tools = await availableTools();
    if (tools.has(TOOL_FOR[key])) return;
    throw new UnsupportedCapabilityError(key, "mcp", `the server does not expose ${TOOL_FOR[key]}`);
  }

  return {
    kind: "mcp",

    async refund(input: RefundInput): Promise<RefundResult> {
      await requireTool("refund");

      const args: Record<string, unknown> = {
        capture_id: input.captureId,
        note_to_payer: input.note,
      };
      // Only a partial refund carries an amount. Sending `amount: 0` for a full
      // one is rejected by PayPal, and sending the capture total when a partial
      // was asked for is the expensive version of that mistake.
      if (input.amountCents !== undefined) {
        args["amount"] = {
          currency_code: input.currency,
          value: (input.amountCents / 100).toFixed(2),
        };
      }

      const body = (await client.callTool("create_refund", args)) as Record<string, unknown>;
      const status = typeof body?.["status"] === "string" ? body["status"] : "";

      // The caller's amount is authoritative for a partial refund, because they
      // asked for it. For a full one the binding has to tell us — and the MCP
      // `create_refund` response does not, so this is `null` rather than a
      // figure we would be inventing. See `RefundResult.amountCents`.
      const echoed = readAmountCents(body?.["amount"]);
      const amountCents = input.amountCents ?? echoed ?? null;

      return {
        refundId: typeof body?.["id"] === "string" ? body["id"] : "",
        // Anything the provider did not call COMPLETED or PENDING is a
        // refusal, and REFUND_STATUS's absence is the refusal - not a default
        // of "completed", which would be the worst possible default here.
        status: REFUND_STATUS[status.toUpperCase()] ?? "failed",
        amountCents,
        currency: input.currency,
        raw: body,
      };
    },

    async cancelSubscription(subscriptionId: string): Promise<ActionResult> {
      await requireTool("cancelSubscription");

      const body = (await client.callTool("cancel_subscription", {
        subscription_id: subscriptionId,
      })) as Record<string, unknown> | null;

      // PayPal answers a successful cancel with 204 and an empty body, so
      // there is no status to check - reaching here at all means the provider
      // accepted it. That is the opposite of the refund case, where an absent
      // status means the provider refused, and the difference is why the two
      // mappings above and here cannot share one helper.
      const status = typeof body?.["status"] === "string" ? body["status"] : "";

      return {
        status: "succeeded",
        providerRef: subscriptionId,
        message: status.length > 0 ? `subscription ${status}` : "subscription cancelled",
        raw: body,
      };
    },

    async resolveDispute(disputeId: string, move: DisputeMove): Promise<ActionResult> {
      // Deliberately does not call requireTool. The tool is present, so a
      // capability check would pass and the lane would run - which is exactly
      // the outcome to avoid. Refused on the grounds, not the availability.
      void disputeId;
      void move;
      return {
        status: "skipped",
        providerRef: null,
        message: DISPUTE_LANE_CLOSED,
        raw: null,
      };
    },
  };
}