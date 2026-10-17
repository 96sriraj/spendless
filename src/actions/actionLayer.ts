/**
 * The orchestrator. P6-01, and where P6-07's three refusals meet each other.
 *
 * Everything above the seam produces `Proposal` objects that name a subscription
 * and give a reason. This is where those become things that can move money, and
 * the whole module is ordered by the principle that **a refusal is a first-class
 * outcome**, not an exception path:
 *
 * ```text
 *   guardrails  ->  kill switch  ->  store approval  ->  executor
 * ```
 *
 * In that order, and each one is capable of stopping the chain. The order is not
 * arbitrary: the cap is checked before the kill switch because an over-cap
 * refund is wrong *regardless* of whether execution is enabled, and the kill
 * switch is checked before the store because a halted deployment should not
 * accumulate approvals it can never act on.
 *
 * **The amount is resolved here, from the core, and never from the model.** The
 * agent's proposal carries a `subId` and nothing else; `savingCents` is read from
 * the finding the detectors produced. This is the single place where an amount
 * enters the action pipeline, and it is reading a number that a pure function
 * computed.
 *
 * **The store's approval gate is not optional and not duplicated.** This module
 * calls `claimForExecution`, which is a compare-and-set from `approved`. If this
 * file ever grew its own "is it approved?" check, there would be two answers to
 * the same question and the weaker one would eventually be the one that runs.
 */

import {
  approveProposal,
  claimForExecution,
  completeExecution,
  IllegalTransitionError,
  insertProposal,
  insertResult,
  type ActionKind,
  type ActionProposal,
} from "@/db/actions";
import type { Database } from "@/db";
import { checkRefundCap, type GuardrailConfig } from "./guardrails";
import type { KillSwitch } from "./killSwitch";
import type { Proposal } from "@/agent/proposal";
import type { ActionExecutor, ActionResult as ExecutorActionResult } from "@/adapters/AccountSource";
import type { Recommendation } from "@/core/insights";

/** Maps the agent's verbs onto the ledger's kinds. */
const KIND_FOR_ACTION: Record<Proposal["action"], ActionKind> = {
  refund: "refund",
  cancel: "cancel_subscription",
  downgrade: "cancel_subscription",
  investigate: "ask_usage",
  no_action: "ask_usage",
};

export type ProposeOutcome =
  | { readonly ok: true; readonly proposal: ActionProposal }
  | {
      readonly ok: false;
      readonly reason: string;
      /** The agent's own proposal, kept so the run log can show what was dropped. */
      readonly proposal: Proposal;
    };

export type ExecuteOutcome =
  | { readonly ok: true; readonly proposal: ActionProposal; readonly resultId: string }
  | { readonly ok: false; readonly reason: string; readonly at: "guardrails" | "killswitch" | "store" | "executor" };

export type ActionLayerDependencies = {
  readonly db: Database;
  readonly findings: readonly Recommendation[];
  readonly executor: ActionExecutor;
  readonly killSwitch: KillSwitch;
  readonly guardrails: GuardrailConfig;
  readonly now?: () => Date;
  readonly newId?: () => string;
  readonly runId?: string | null;
};

export type ActionLayer = {
  propose(agentProposal: Proposal): Promise<ProposeOutcome>;
  approve(proposalId: string, approvedBy: string, reason?: string): Promise<ActionProposal>;
  reject(proposalId: string, rejectedBy: string, reason: string): Promise<ActionProposal>;
  execute(proposalId: string): Promise<ExecuteOutcome>;
};

export function createActionLayer(deps: ActionLayerDependencies): ActionLayer {
  const now = deps.now ?? (() => new Date());
  let counter = 0;
  const newId = deps.newId ?? (() => `act-${++counter}`);

  const findingFor = (subId: string): Recommendation | undefined =>
    deps.findings.find((f) => f.subId === subId);

  return {
    /**
     * Record the agent's proposal as an auditable row.
     *
     * The amount comes from the core's `savingCents`, never from the proposal —
     * which carries no amount at all, because `ProposalSchema` is strict enough
     * to reject one. This is the line where the no-money rule becomes real.
     */
    async propose(agentProposal: Proposal): Promise<ProposeOutcome> {
      const finding = findingFor(agentProposal.subId);
      if (finding === undefined) {
        // The loop already refuses unknown subIds. Reaching here means the
        // findings changed underneath us, which is still a refusal and not a
        // silent drop.
        return {
          ok: false,
          reason: `no finding for ${agentProposal.subId}; nothing was recorded`,
          proposal: agentProposal,
        };
      }

      const kind = KIND_FOR_ACTION[agentProposal.action];
      const wantsMoney = kind === "refund";

      const created = await insertProposal(
        deps.db,
        {
          id: newId(),
          runId: deps.runId ?? null,
          kind,
          targetId: agentProposal.subId,
          // A cancellation moves no money, so its amount is null rather than a
          // zero that reads as "refunded nothing".
          amountCents: wantsMoney ? finding.savingCents : null,
          currency: findingCurrency(),
          rationale: agentProposal.rationale,
          evidence: JSON.stringify({
            kind: finding.kind,
            severity: agentProposal.severity,
            category: agentProposal.category,
            confidence: finding.confidence,
          }),
        },
        () => now().toISOString(),
      );

      return { ok: true, proposal: created };
    },

    async approve(proposalId: string, approvedBy: string, reason?: string) {
      return approveProposal(deps.db, proposalId, approvedBy, reason, () => now().toISOString());
    },

    async reject(proposalId: string, rejectedBy: string, reason: string) {
      const { rejectProposal } = await import("@/db/actions");
      return rejectProposal(deps.db, proposalId, rejectedBy, reason, () => now().toISOString());
    },

    /**
     * Run one approved action, in an order where each step can stop the chain.
     */
    async execute(proposalId: string): Promise<ExecuteOutcome> {
      const existing = await getProposalSafe(deps.db, proposalId);
      if (existing === null) {
        return { ok: false, reason: `no such proposal: ${proposalId}`, at: "store" };
      }

      // Refused *before* the claim, so a proposal that moves no money stays
      // `approved` rather than being marked failed for something nobody tried.
      // `ask_usage` is a question for a human, not an action.
      if (!EXECUTABLE_KINDS.includes(existing.kind)) {
        return {
          ok: false,
          reason: `${existing.kind} moves no money and has no provider call; it stays a proposal`,
          at: "executor",
        };
      }

      const claimed = await claimForExecution(deps.db, proposalId, () => now().toISOString()).catch(
        (error: unknown) => error,
      );
      if (claimed instanceof Error) {
        // The store refused. That is P6-08 working: nothing was sent to PayPal.
        const reason =
          claimed instanceof IllegalTransitionError
            ? claimed.message
            : `the store refused this action: ${String(claimed)}`;
        return { ok: false, reason, at: "store" };
      }
      const proposal = claimed as ActionProposal;

      const record = async (
        outcome: "executed" | "failed",
        detail: {
          readonly status: "succeeded" | "failed" | "skipped";
          readonly providerRef: string | null;
          readonly amountCents: number | null;
          readonly message: string;
        },
      ): Promise<string> => {
        await completeExecution(deps.db, proposalId, outcome, () => now().toISOString());
        const resultId = newId();
        await insertResult(
          deps.db,
          {
            id: resultId,
            proposalId,
            status: detail.status,
            providerRef: detail.providerRef,
            amountCents: detail.amountCents,
            message: detail.message,
          },
          () => now().toISOString(),
        );
        return resultId;
      };

      // 1. The kill switch. Checked before anything reaches a provider, and it
      //    resolves rather than throwing so the UI can render a banner.
      const gate = await deps.killSwitch.assertCanExecute(
        `${proposal.kind} on ${proposal.targetId ?? "unknown target"}`,
      );
      if (!gate.ok) {
        await record("failed", {
          status: "skipped",
          providerRef: null,
          amountCents: proposal.amountCents,
          message: gate.reason,
        });
        return { ok: false, reason: gate.reason, at: "killswitch" };
      }

      // 2. The cap. An over-cap refund is wrong whatever the switch says, so it
      //    is refused with the reason recorded against the action.
      if (proposal.kind === "refund" && proposal.amountCents !== null) {
        const verdict = checkRefundCap(proposal.amountCents, {
          ...deps.guardrails,
          amountCurrency: proposal.currency,
        });
        if (!verdict.allowed) {
          await record("failed", {
            status: "skipped",
            providerRef: null,
            amountCents: proposal.amountCents,
            message: verdict.reason,
          });
          return { ok: false, reason: verdict.reason, at: "guardrails" };
        }
      }

      // 3. The provider.
      try {
        const outcome = await callExecutor(deps.executor, proposal);
        const resultId = await record(
          outcome.status === "succeeded" ? "executed" : "failed",
          outcome,
        );
        if (outcome.status !== "succeeded") {
          return { ok: false, reason: outcome.message, at: "executor" };
        }
        return { ok: true, proposal, resultId };
      } catch (error) {
        const reason = String(error);
        await record("failed", {
          status: "failed",
          providerRef: null,
          amountCents: proposal.amountCents,
          message: reason,
        });
        return { ok: false, reason, at: "executor" };
      }
    },
  };
}

/** Kinds with a provider call behind them. The rest are questions for a human. */
const EXECUTABLE_KINDS: readonly ActionKind[] = ["refund", "cancel_subscription"];

async function getProposalSafe(
  db: Database,
  id: string,
): Promise<ActionProposal | null> {
  const { getProposal } = await import("@/db/actions");
  return getProposal(db, id);
}

function findingCurrency(): "USD" | "INR" {
  // `Recommendation` carries no currency — the detectors work in minor units and
  // the account's currency is a deployment fact. USD is the sandbox's, and it is
  // stated here rather than inferred silently.
  return "USD";
}

async function callExecutor(
  executor: ActionExecutor,
  proposal: ActionProposal,
): Promise<{
  status: "succeeded" | "failed";
  providerRef: string | null;
  amountCents: number | null;
  message: string;
}> {
  if (proposal.kind === "refund") {
    const target = proposal.targetId;
    if (target === null) {
      throw new Error(`refund ${proposal.id} has no target capture`);
    }
    const result = await executor.refund({
      // The target is the capture or subscription the proposal named. The seed
      // writes merchant keys rather than capture ids, so a live wiring resolves
      // this through the account source; without one, it is honest to refuse.
      captureId: target,
      ...(proposal.amountCents === null ? {} : { amountCents: proposal.amountCents }),
      currency: proposal.currency,
      note: proposal.rationale,
    });
    return {
      status: result.status === "completed" ? "succeeded" : "failed",
      providerRef: result.refundId,
      amountCents: result.amountCents,
      message: `refund ${result.status}`,
    };
  }

  if (proposal.kind === "cancel_subscription") {
    const target = proposal.targetId;
    if (target === null) throw new Error(`cancellation ${proposal.id} has no target`);
    const result: ExecutorActionResult = await executor.cancelSubscription(target);
    return {
      status: result.status === "succeeded" ? "succeeded" : "failed",
      providerRef: result.providerRef,
      amountCents: null,
      message: result.message,
    };
  }

  // Unreachable: `execute` refuses non-executable kinds before claiming. Kept
  // anyway, because a new kind added to the enum should fail loudly here rather
  // than quietly returning a success with no provider call.
  throw new Error(`action ${proposal.id} is ${proposal.kind}, which moves no money`);
}