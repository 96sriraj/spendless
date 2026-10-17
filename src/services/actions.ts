/**
 * Turning an agent run into approvable rows, and approving them.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 * ---------------------------------------------------------------------------
 *
 * `runAgent` returns proposals, `streamAgentRun` forwards them in a `done` event,
 * and nothing wrote them anywhere. After a run the screen had a proposal and
 * **nothing to approve** — the entire action layer sat behind a gap with one
 * missing line in it. This is that line.
 *
 * It is a service rather than route-handler code for the same reason
 * `runStream.ts` is: the interesting behaviour (where the amount comes from, what
 * a refusal looks like, what an unapproved execute does) is invisible from a
 * route, and none of it needs a socket to prove.
 *
 * ---------------------------------------------------------------------------
 * THE AMOUNT IS NOT THE MODEL'S, AND THIS IS WHERE THAT BECOMES REAL
 * ---------------------------------------------------------------------------
 *
 * `ProposalSchema` is `.strict()` and has no money field, so a proposal cannot
 * carry an amount however confidently the model asks. The figure on an approvable
 * row is resolved from the finding's `savingCents` in the core, which is the only
 * place a refundable number is allowed to come from.
 */

import { createActionLayer, type ActionLayer } from "@/actions/actionLayer";
import { createKillSwitch, type KillSwitch } from "@/actions/killSwitch";
import type { ActionExecutor, RefundInput } from "@/adapters/AccountSource";
import type { Proposal } from "@/agent/proposal";
import type { Recommendation } from "@/core/insights";
import type { Currency } from "@/core/validators";
import type { ActionProposal } from "@/db/actions";
import type { Database } from "@/db";

export type RecordedProposals = {
  readonly recorded: readonly ActionProposal[];
  /** Refusals, kept so the run log can show what was dropped rather than hiding it. */
  readonly refused: readonly { readonly subId: string; readonly reason: string }[];
};

export type RecordOptions = {
  readonly db: Database;
  readonly agentProposals: readonly Proposal[];
  readonly findings: readonly Recommendation[];
  readonly now: Date;
  readonly runId?: string | null;
  readonly currency?: Currency;
  /**
   * Makes two runs' proposal ids distinct.
   *
   * Required, not optional. `now` is injected for determinism, so two runs share
   * it exactly — and an id built from the clock alone collides on the primary key
   * every time. That fails only under a fixed clock, so it never appears in a
   * demo, where the clock moves and the ids happen to differ. The caller knows its
   * run id; this does not, so the caller supplies the discriminator.
   */
  readonly idPrefix: string;
};

export async function recordAgentProposals(options: RecordOptions): Promise<RecordedProposals> {
  const recorded: ActionProposal[] = [];
  const refused: { subId: string; reason: string }[] = [];

  let counter = 0;
  const layer = createActionLayer({
    db: options.db,
    findings: options.findings,
    // `recordAgentProposals` only writes rows; it never reaches an executor, so
    // this one is never called. It is wired anyway because `ActionLayer` takes a
    // whole executor rather than an optional one, and making that optional for
    // one code path would be a worse change than passing something that cannot
    // be reached.
    executor: unavailableExecutor(),
    killSwitch: createKillSwitch({ executionEnabled: true }),
    guardrails: { limits: { refundCapCents: 0, currency: options.currency ?? "USD" } },
    now: () => options.now,
    // Run id first, then position: unique within a run, unique between runs, and
    // readable in a D1 browser at 11pm during a demo.
    newId: () => `act-${options.idPrefix}-${++counter}`,
    runId: options.runId ?? null,
  });

  for (const proposal of options.agentProposals) {
    const outcome = await layer.propose(proposal);
    if (outcome.ok) {
      recorded.push(outcome.proposal);
    } else {
      refused.push({ subId: proposal.subId, reason: outcome.reason });
    }
  }

  return { recorded, refused };
}

export type ApproveOutcome =
  | { readonly ok: true; readonly proposal: ActionProposal; readonly message: string }
  | { readonly ok: false; readonly reason: string; readonly at: "store" | "executor" | "guardrails" | "killswitch" };

export type ApproveOptions = {
  readonly db: Database;
  readonly proposalId: string;
  readonly findings: readonly Recommendation[];
  readonly executor: ActionExecutor;
  readonly killSwitch: KillSwitch;
  readonly refundCapCents: number;
  readonly approvedBy: string;
  readonly now: Date;
  readonly currency?: Currency;
};

/**
 * Approve one proposal and run it.
 *
 * Approval is a separate, explicit step from execution even though this does
 * both. The brief is "make the payment quickly", and a single click is right —
 * but the *enforcement* is unchanged: `claimForExecution` is still a conditional
 * update, so a second click loses the race and nothing is sent twice. Speed at
 * the surface, compare-and-set underneath.
 */
export async function approveAndExecute(options: ApproveOptions): Promise<ApproveOutcome> {
  const layer = buildLayer(options);
  try {
    await layer.approve(options.proposalId, options.approvedBy);
  } catch (error: unknown) {
    // `approveProposal` throws `IllegalTransitionError` for a proposal that is
    // not `proposed` — including one already executed. Reported, not thrown, so
    // the screen gets a sentence.
    return {
      ok: false,
      at: "store",
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  const outcome = await layer.execute(options.proposalId);
  if (outcome.ok) {
    return {
      ok: true,
      proposal: outcome.proposal,
      message: "approved and executed",
    };
  }

  return { ok: false, at: outcome.at, reason: outcome.reason };
}

function buildLayer(options: ApproveOptions): ActionLayer {
  const currency = options.currency ?? "USD";
  return createActionLayer({
    db: options.db,
    findings: options.findings,
    executor: options.executor,
    killSwitch: options.killSwitch,
    guardrails: { limits: { refundCapCents: options.refundCapCents, currency } },
    now: () => options.now,
  });
}

/**
 * The executor used when no PayPal client is wired.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT A "SANDBOX EXECUTOR" THAT SUCCEEDS
 * ---------------------------------------------------------------------------
 *
 * The temptation was an executor that returns `completed` and writes a plausible
 * refund id. That is the most dangerous thing this repository could grow: it is
 * indistinguishable from the real one, it passes every test, and it ships a refund
 * button that moves no money while reporting that it did.
 *
 * So nothing pretends. This declines, and its reason says plainly that nothing was
 * sent. Everything above it — the cap, the kill switch, the store's
 * compare-and-set claim — is real and still enforced, and that is the part worth
 * demonstrating on screen. The money is the part that honestly is not wired here,
 * and the screen says so rather than implying otherwise.
 *
 * The refund id is deliberately not refund-shaped. Something downstream may render
 * it, and a plausible-looking `40551413F19556526` next to "nothing was sent" would
 * be worse than an obvious placeholder.
 */
export function unavailableExecutor(): ActionExecutor {
  const message =
    "no PayPal executor is wired in this environment; nothing was sent to PayPal";

  return {
    kind: "unavailable",
    async refund(input: RefundInput) {
      return {
        refundId: "none",
        status: "failed",
        amountCents: null,
        currency: input.currency,
        message,
        raw: null,
      };
    },
    async cancelSubscription() {
      return { status: "failed", providerRef: null, message, raw: null };
    },
    async resolveDispute() {
      return { status: "failed", providerRef: null, message, raw: null };
    },
  };
}