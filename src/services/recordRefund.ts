/**
 * Recording a refund that happened OUT of process.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 *
 * The demo has two execution paths. Option B (the Worker route) runs the guardrail
 * chain and then honestly declines, because workerd cannot spawn the MCP stdio
 * server. Option A — the video path — refunds real sandbox money through the
 * local sidecar (`scripts/refundServer.ts`), and until now that wrote NOTHING to
 * the store: real money moved both ways and `buildReadModel` kept claiming the
 * money was still at risk, forever, across every refresh.
 *
 * This module closes that gap. The UI calls `POST /api/actions/record` after a
 * successful sidecar refund, and the store performs the same transitions the
 * in-process path would have: `proposed -> approved -> executing -> executed`,
 * plus an `action_results` row carrying the REAL refund id PayPal returned.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS, AND IS NOT
 * ---------------------------------------------------------------------------
 *
 * - **It moves no money.** Execution already happened out of process; this is
 *   bookkeeping about money that already moved. That is why the guardrails and
 *   the kill switch are not re-run here: refusing to record does not un-refund,
 *   it just leaves the screen lying.
 * - **It fabricates nothing.** The result row's amount is the proposal's own
 *   `amountCents`, read back from the store — never a figure the client typed.
 * - **It will not fast-forward an as-yet-unapproved proposal.** The transitions
 *   are conditional updates (`ARCHITECTURE.md` §7); `changes === 0` is the
 *   refusal, so a second recording loses the race and writes no duplicate.
 */

import {
  approveProposal,
  claimForExecution,
  completeExecution,
  getProposal,
  IllegalTransitionError,
  insertResult,
  type ActionProposal,
} from "@/db/actions";
import type { Currency } from "@/core/validators";
import type { Database } from "@/db";

export type RecordRefundOutcome =
  | { readonly ok: true; readonly message: string; readonly proposalId: string }
  | { readonly ok: false; readonly reason: string; readonly proposalId: string };

export type RecordRefundInput = {
  readonly db: Database;
  readonly proposalId: string;
  /** The subscription the refund was against, as the sidecar reported it. */
  readonly subId: string;
  /** The real refund id PayPal returned. Proof, not decoration. */
  readonly refundId: string;
  readonly amountCents: number;
  readonly currency: Currency;
  readonly approvedBy?: string;
};

export async function recordExecutedRefund(
  input: RecordRefundInput,
  now: () => string = () => new Date().toISOString(),
): Promise<RecordRefundOutcome> {
  const refused = (reason: string): RecordRefundOutcome => ({
    ok: false,
    reason,
    proposalId: input.proposalId,
  });

  const proposal = await getProposal(input.db, input.proposalId);
  if (proposal === null) return refused(`no such proposal: ${input.proposalId}`);

  if (proposal.kind !== "refund") {
    return refused(`${proposal.kind} moves no money; there is no real refund to record`);
  }
  if (proposal.targetId !== input.subId) {
    return refused(
      `this refund was against ${input.subId}, but the proposal named ${proposal.targetId ?? "nothing"}`,
    );
  }
  if (proposal.currency !== input.currency) {
    return refused(
      `the refund settled in ${input.currency} but the proposal is denominated in ${proposal.currency}`,
    );
  }
  if (proposal.amountCents === null) {
    return refused(`the proposal carries no approved amount, so there is nothing to record`);
  }
  if (proposal.amountCents !== input.amountCents) {
    return refused(
      `the refund settled for ${input.amountCents} cents but the approved amount was ${proposal.amountCents}`,
    );
  }

  try {
    await approveProposal(input.db, input.proposalId, input.approvedBy ?? "merchant (recorded from the sidecar)", undefined, now);
    await claimForExecution(input.db, input.proposalId, now);
    await completeExecution(input.db, input.proposalId, "executed", now);
  } catch (error: unknown) {
    // `changes === 0` IS the refusal — an already-recorded proposal lands here,
    // which is a lost race and a sentence, not a second result row.
    return refused(
      error instanceof IllegalTransitionError
        ? error.message
        : `the store refused to record this refund: ${String(error)}`,
    );
  }

  await insertResult(
    input.db,
    {
      id: `rec-${input.proposalId}`,
      proposalId: input.proposalId,
      status: "succeeded",
      // The real refund id from PayPal. The read model reads this column as
      // proof, so a placeholder here would be a fabricated recovery.
      providerRef: input.refundId,
      amountCents: proposal.amountCents,
      message: `refund ${input.refundId} recorded; executed out of process via the local sidecar`,
    },
    now,
  );

  return {
    ok: true,
    message: `refund ${input.refundId} recorded against ${input.subId}`,
    proposalId: input.proposalId,
  };
}

/** Kept for parity with the executor path: the type the route handler echoes. */
export type RecordedProposal = ActionProposal;
