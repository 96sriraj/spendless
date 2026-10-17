/**
 * What the agent is allowed to say.
 *
 * ---------------------------------------------------------------------------
 * THE ONE RULE: NO MONEY. Not a convention, a schema.
 * ---------------------------------------------------------------------------
 *
 * `AGENTS.md`: *"The LLM classifies, reasons, ranks, and drafts rationale. It
 * does not compute a normalised monthly figure, decide a refund amount, or
 * execute anything. Every figure on screen traces to a pure function in the
 * core."*
 *
 * A prompt that says "do not compute amounts" is a request. `z.object({...}).strict()`
 * is a boundary: a proposal carrying `amountCents` is **rejected**, whatever the
 * model was told, however confident it sounded, and however reasonable the
 * number looked. A model asked to be careful will eventually be careless, and
 * the failure mode is a plausible figure in the run log that no pure function
 * produced.
 *
 * So a proposal names a **subscription** and gives a **reason**. The action layer
 * (Phase 6) resolves `subId` to an amount through the core, where `savingCents`
 * is already computed and already the ranking axis (`insights.ts`, invariant 2).
 * That value is never round-tripped through the model.
 *
 * **`severity` is not the money ranking.** It is a judgement about urgency and it
 * is deliberately a separate axis: `savingCents` sorts by forward monthly
 * saving, and collapsing the two into one "score" is how a $2 finding ends up
 * ranked above a $40 one because the model was more emphatic about it.
 */

import { z } from "zod";

/** What the agent thinks should happen. Deliberately no "execute" — that is Phase 6. */
export const ACTION_KINDS = ["refund", "cancel", "downgrade", "investigate", "no_action"] as const;

export const ActionKindSchema = z.enum(ACTION_KINDS);
export type AgentAction = z.infer<typeof ActionKindSchema>;

/** The agent's own classification of the problem, independent of detector kind. */
export const CATEGORIES = [
  "idle_subscription",
  "duplicate_charge",
  "price_increase",
  "failed_renewal",
  "healthy",
] as const;

export const CategorySchema = z.enum(CATEGORIES);
export type AgentCategory = z.infer<typeof CategorySchema>;

export const ProposalSchema = z
  .object({
    /**
     * Names a subscription the agent was shown. Validated against the actual
     * findings before it is accepted — see `agent.ts` — because a well-formed
     * proposal about a subscription nobody pays for is the worst failure this
     * layer can produce.
     */
    subId: z.string().min(1),

    action: ActionKindSchema,

    category: CategorySchema,

    /** 1 (can wait) to 5 (this week). Not the money ranking — see above. */
    severity: z.number().int().min(1).max(5),

    /** One sentence a merchant can read. Never contains a figure we did not compute. */
    rationale: z.string().min(1).max(400),
  })
  // `.strict()` is the whole point of this file. Unknown keys are rejected, so
  // `amountCents` cannot ride along inside a valid proposal.
  .strict();

export type Proposal = z.infer<typeof ProposalSchema>;

/** A tool call the loop refused. Recorded, never executed, never retried silently. */
export type Rejection = {
  readonly toolName: string;
  readonly reason: string;
  /** Enough to debug with, and deliberately not echoing the arguments verbatim. */
  readonly detail: string;
  readonly turn: number;
};

export type StopReason = "answered" | "turn_cap";

export type AgentRun = {
  readonly proposals: readonly Proposal[];
  /** Every refusal this run produced. Empty on a clean run. */
  readonly rejections: readonly Rejection[];
  readonly turns: number;
  readonly stoppedBecause: StopReason;
  readonly totalTokens: number | null;
  /** The model's closing words. Shown in the run log; never parsed for truth. */
  readonly finalText: string;
  /** Every tool call and what came back, in order. The demo's evidence. */
  readonly transcript: readonly TranscriptEntry[];
};

export type TranscriptEntry = {
  readonly turn: number;
  readonly kind: "llm_call" | "tool_call" | "tool_result" | "rejected";
  readonly label: string;
  readonly payload?: unknown;
};