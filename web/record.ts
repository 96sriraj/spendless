/**
 * What gets recorded into the store after an Option-A sidecar refund.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS PURE AND NOT PART OF `RunPanel.tsx`
 * ---------------------------------------------------------------------------
 *
 * The same argument that produced `hero.ts` and `runlog.ts`: the decision of
 * WHICH results become ledger rows is worth testing without a DOM, and the
 * component is a `map` and a button. A duplicate row in `action_results` is a
 * double count of recovered money, so the mapping is a function with tests, not
 * a fetch inside a callback.
 *
 * ---------------------------------------------------------------------------
 * THE RULE: RECORD WHAT PAYPAL SETTLED, NOTHING ELSE
 * ---------------------------------------------------------------------------
 *
 * - Only `ok === true` results with a refund id and status `COMPLETED` — a
 *   refused sidecar refund (PayPal answering "already refunded" on a take
 *   re-run) is shown to the merchant verbatim and recorded NO-where.
 * - One payload per subId, deduped rather than trusted on arrival.
 * - The amount is the amount PayPal actually settled, and the store's own
 *   validation refuses the recording if it disagrees with the proposal — so
 *   this module never has to police amounts beyond an honest floor.
 */

import type { LocalRefundResult } from "./localRefund";
import type { RunProposal } from "./runlog";

/** The shape `recordPayloadsFor` matches against; `RunProposal` satisfies it. */
export type RecordCandidate = {
  readonly id: string;
  readonly subId: string;
  readonly amountCents: number | null;
  readonly currency: string;
};

/** One settled refund, framed for `POST /api/actions/record`. */
export type RecordPayload = {
  readonly proposalId: string;
  readonly subId: string;
  readonly refundId: string;
  readonly status: "COMPLETED";
  readonly amountCents: number;
  readonly currency: string;
};

export function recordPayloadsFor(
  candidates: readonly RecordCandidate[],
  results: readonly LocalRefundResult[],
): readonly RecordPayload[] {
  const bySubId = new Map<string, { proposalId: string; refundId: string; amountCents: number }>();

  for (const result of results) {
    if (result.ok !== true) continue;
    if (result.status !== "COMPLETED") continue;
    if (result.refundId === undefined) continue;
    if (bySubId.has(result.subId)) continue;

    const proposal = candidates.find((c) => c.subId === result.subId);
    if (proposal === undefined) continue;

    const amountCents =
      typeof result.amountCents === "number" && result.amountCents > 0
        ? result.amountCents
        : proposal.amountCents;
    if (amountCents === null || amountCents <= 0) continue;

    bySubId.set(result.subId, {
      proposalId: proposal.id,
      refundId: result.refundId,
      amountCents,
    });
  }

  return [...bySubId.entries()].map(([subId, recorded]) => ({
    proposalId: recorded.proposalId,
    subId,
    refundId: recorded.refundId,
    status: "COMPLETED",
    amountCents: recorded.amountCents,
    currency: candidates.find((c) => c.subId === subId)?.currency ?? "USD",
  }));
}

/**
 * Tell the store about one settled refund. Resolves `false` on any refusal — a
 * lost race ("already recorded"), a mismatch, or an unreachable Worker — which
 * the caller leaves alone: the store then keeps reporting the risk, which is
 * where a recording that failed belongs.
 */
export async function recordRefund(payload: RecordPayload): Promise<boolean> {
  try {
    const response = await fetch("/api/actions/record", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) return false;
    const body = (await response.json().catch(() => ({}))) as {
      ok?: boolean;
      outcomes?: { ok: boolean }[];
    };
    return body.ok === true && (body.outcomes?.[0]?.ok ?? false) === true;
  } catch {
    return false;
  }
}

/**
 * Narrow a run-log proposal into the record candidate shape it already has.
 * Here so `RunPanel` does not have to appear to know the ledger's business.
 */
export function candidateOf(proposal: RunProposal): RecordCandidate {
  return {
    id: proposal.id,
    subId: proposal.subId,
    amountCents: proposal.amountCents,
    currency: proposal.currency,
  };
}
