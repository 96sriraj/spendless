/**
 * The action ledger. P6-01, and the mechanism behind P6-08.
 *
 * `proposal -> approval -> execution -> result`, all four persisted.
 * `ARCHITECTURE.md` §7 calls this the safety story, and the thing that makes it
 * a safety story rather than a workflow diagram is **where the enforcement
 * lives**: here, in the store, not in the UI.
 *
 * `todo.md` P6-08 is explicit — *"an attempt to execute without an approval to
 * be refused by the store, not by the UI"* — and the reason is the obvious one:
 * UI-level enforcement is not enforcement. A disabled button is a request. A
 * `POST /execute` is not.
 *
 * So the transitions are **conditional updates**, not reads followed by writes:
 *
 * ```sql
 * UPDATE action_proposals SET status = 'executing' WHERE id = ? AND status = 'approved'
 * ```
 *
 * `changes === 0` means the row is not in a state that can legally become
 * executing, and the claim is refused. That is a compare-and-set performed by
 * the database, so it holds against a direct HTTP POST, a concurrent request, and
 * a bug in the caller — none of which the UI can prevent and all of which this
 * can.
 *
 * Reading the status first and then writing it is the obvious implementation and
 * it is wrong: it leaves a window between the read and the write in which two
 * requests both see `approved` and both execute a refund.
 */

import type { Database } from "./index";
import type { Currency } from "@/core/validators";

export const ACTION_KINDS = [
  "refund",
  "cancel_subscription",
  "resolve_dispute",
  "ask_usage",
] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

export const PROPOSAL_STATUSES = [
  "proposed",
  "approved",
  "executing",
  "executed",
  "rejected",
  "failed",
  "expired",
] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

export type ActionProposal = {
  readonly id: string;
  readonly runId: string | null;
  readonly kind: ActionKind;
  readonly status: ProposalStatus;
  readonly targetId: string | null;
  readonly amountCents: number | null;
  readonly currency: Currency;
  readonly rationale: string;
  readonly evidence: string | null;
  /** Always 1. A CHECK constraint, not a convention — see schema.sql. */
  readonly requiresApproval: true;
  readonly approvedAt: string | null;
  readonly approvedBy: string | null;
  readonly createdAt: string;
  readonly decidedAt: string | null;
  readonly decisionReason: string | null;
};

export type ActionResult = {
  readonly id: string;
  readonly proposalId: string;
  readonly status: "succeeded" | "failed" | "skipped";
  readonly providerRef: string | null;
  readonly amountCents: number | null;
  readonly message: string | null;
  readonly executedAt: string;
};

/**
 * Raised when a transition is refused. A distinct type rather than a bare Error
 * because an HTTP layer has to turn this into a 409 rather than a 500 — "you
 * skipped a step" is not a server fault.
 */
export class IllegalTransitionError extends Error {
  readonly proposalId: string;
  readonly from: string;
  readonly to: string;

  constructor(proposalId: string, from: string, to: string, detail: string) {
    super(`cannot move proposal ${proposalId} from ${from} to ${to}: ${detail}`);
    this.name = "IllegalTransitionError";
    this.proposalId = proposalId;
    this.from = from;
    this.to = to;
  }
}

function toProposal(row: Record<string, unknown>): ActionProposal {
  return {
    id: String(row["id"]),
    runId: row["run_id"] === null || row["run_id"] === undefined ? null : String(row["run_id"]),
    kind: String(row["kind"]) as ActionKind,
    status: String(row["status"]) as ProposalStatus,
    targetId:
      row["target_id"] === null || row["target_id"] === undefined ? null : String(row["target_id"]),
    amountCents: row["amount_cents"] === null || row["amount_cents"] === undefined
      ? null
      : Number(row["amount_cents"]),
    currency: String(row["currency"]) as Currency,
    rationale: String(row["rationale"]),
    evidence: row["evidence"] === null || row["evidence"] === undefined ? null : String(row["evidence"]),
    // Narrowed deliberately: the column is `CHECK (requires_approval = 1)`, so
    // anything else cannot be in the table at all.
    requiresApproval: true,
    approvedAt:
      row["approved_at"] === null || row["approved_at"] === undefined ? null : String(row["approved_at"]),
    approvedBy:
      row["approved_by"] === null || row["approved_by"] === undefined ? null : String(row["approved_by"]),
    createdAt: String(row["created_at"]),
    decidedAt:
      row["decided_at"] === null || row["decided_at"] === undefined ? null : String(row["decided_at"]),
    decisionReason:
      row["decision_reason"] === null || row["decision_reason"] === undefined
        ? null
        : String(row["decision_reason"]),
  };
}

export async function insertProposal(
  db: Database,
  proposal: {
    readonly id: string;
    readonly runId?: string | null;
    readonly kind: ActionKind;
    readonly targetId?: string | null;
    readonly amountCents?: number | null;
    readonly currency: Currency;
    readonly rationale: string;
    readonly evidence?: string | null;
  },
  now: () => string = () => new Date().toISOString(),
): Promise<ActionProposal> {
  const createdAt = now();
  await db.run(
    `INSERT INTO action_proposals
       (id, run_id, kind, status, target_id, amount_cents, currency, rationale, evidence,
        requires_approval, created_at)
     VALUES (?, ?, ?, 'proposed', ?, ?, ?, ?, ?, 1, ?)`,
    proposal.id,
    proposal.runId ?? null,
    proposal.kind,
    proposal.targetId ?? null,
    proposal.amountCents ?? null,
    proposal.currency,
    proposal.rationale,
    proposal.evidence ?? null,
    createdAt,
  );

  const stored = await getProposal(db, proposal.id);
  if (stored === null) throw new Error(`proposal ${proposal.id} vanished immediately after insert`);
  return stored;
}

export async function getProposal(db: Database, id: string): Promise<ActionProposal | null> {
  const row = await db.get<Record<string, unknown>>(
    "SELECT * FROM action_proposals WHERE id = ?",
    id,
  );
  return row === null ? null : toProposal(row);
}

export async function listProposals(db: Database, runId?: string): Promise<ActionProposal[]> {
  const rows =
    runId === undefined
      ? await db.all<Record<string, unknown>>("SELECT * FROM action_proposals ORDER BY created_at, id")
      : await db.all<Record<string, unknown>>(
          "SELECT * FROM action_proposals WHERE run_id = ? ORDER BY created_at, id",
          runId,
        );
  return rows.map(toProposal);
}

/**
 * Move `from -> to`, or refuse.
 *
 * The whole of the state machine is the `AND status = ?` in the WHERE clause.
 * `changes === 0` is not an error path — it is the answer, and the database
 * produced it.
 */
async function transition(
  db: Database,
  id: string,
  from: ProposalStatus,
  to: ProposalStatus,
  extra: { readonly sql: string; readonly params: readonly unknown[] },
  detail: string,
  now: () => string,
): Promise<ActionProposal> {
  const at = now();
  const result = await db.run(
    `UPDATE action_proposals SET status = ?, decided_at = ?${extra.sql}
     WHERE id = ? AND status = ?`,
    to,
    at,
    ...extra.params,
    id,
    from,
  );

  if (result.changes === 0) {
    // Distinguish "no such proposal" from "wrong state" — they are different
    // answers and the second one is the security-relevant one.
    const current = await getProposal(db, id);
    if (current === null) {
      throw new IllegalTransitionError(id, "(absent)", to, "no such proposal");
    }
    throw new IllegalTransitionError(id, current.status, to, detail);
  }

  const stored = await getProposal(db, id);
  if (stored === null) throw new Error(`proposal ${id} vanished during ${from} -> ${to}`);
  return stored;
}

/**
 * A human says yes. The only way into `approved`.
 *
 * `approved_by` is recorded because "who moved the money" is the first question
 * asked after an incident, and an audit trail that answers "approved: yes" is
 * not one.
 */
export function approveProposal(
  db: Database,
  id: string,
  approvedBy: string,
  reason?: string,
  now: () => string = () => new Date().toISOString(),
): Promise<ActionProposal> {
  return transition(
    db,
    id,
    "proposed",
    "approved",
    {
      sql: ", approved_at = ?, approved_by = ?, decision_reason = COALESCE(?, decision_reason)",
      params: [now(), approvedBy, reason ?? null],
    },
    "only a proposed action can be approved, and approval requires a named human",
    now,
  );
}

export function rejectProposal(
  db: Database,
  id: string,
  rejectedBy: string,
  reason: string,
  now: () => string = () => new Date().toISOString(),
): Promise<ActionProposal> {
  return transition(
    db,
    id,
    "proposed",
    "rejected",
    {
      sql: ", approved_by = ?, decision_reason = ?",
      params: [rejectedBy, reason],
    },
    "only a proposed action can be rejected",
    now,
  );
}

/**
 * Claim an approved action for execution. This is the gate P6-08 is about.
 *
 * Compare-and-set from `approved` only. A proposal still sitting at `proposed`
 * — never approved — cannot be claimed, no matter who calls this or how the
 * call arrived.
 */
export function claimForExecution(
  db: Database,
  id: string,
  now: () => string = () => new Date().toISOString(),
): Promise<ActionProposal> {
  return transition(
    db,
    id,
    "approved",
    "executing",
    { sql: "", params: [] },
    "execution requires a prior approval. No money moves without a human saying yes",
    now,
  );
}

/** Settle a claimed action. Separate from the claim so a crash is visible. */
export function completeExecution(
  db: Database,
  id: string,
  outcome: "executed" | "failed",
  now: () => string = () => new Date().toISOString(),
): Promise<ActionProposal> {
  return transition(
    db,
    id,
    "executing",
    outcome,
    { sql: "", params: [] },
    "only a claimed action can be settled",
    now,
  );
}

export async function insertResult(
  db: Database,
  result: {
    readonly id: string;
    readonly proposalId: string;
    readonly status: "succeeded" | "failed" | "skipped";
    readonly providerRef?: string | null;
    readonly amountCents?: number | null;
    readonly message?: string | null;
  },
  now: () => string = () => new Date().toISOString(),
): Promise<ActionResult> {
  await db.run(
    `INSERT INTO action_results
       (id, proposal_id, status, provider_ref, amount_cents, message, executed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    result.id,
    result.proposalId,
    result.status,
    result.providerRef ?? null,
    result.amountCents ?? null,
    result.message ?? null,
    now(),
  );
  return {
    id: result.id,
    proposalId: result.proposalId,
    status: result.status,
    providerRef: result.providerRef ?? null,
    amountCents: result.amountCents ?? null,
    message: result.message ?? null,
    executedAt: now(),
  };
}

export async function listResults(
  db: Database,
  proposalId: string,
): Promise<ActionResult[]> {
  const rows = await db.all<Record<string, unknown>>(
    "SELECT * FROM action_results WHERE proposal_id = ? ORDER BY executed_at, id",
    proposalId,
  );
  return rows.map((row) => ({
    id: String(row["id"]),
    proposalId: String(row["proposal_id"]),
    status: String(row["status"]) as ActionResult["status"],
    providerRef: row["provider_ref"] === null ? null : String(row["provider_ref"]),
    amountCents: row["amount_cents"] === null ? null : Number(row["amount_cents"]),
    message: row["message"] === null ? null : String(row["message"]),
    executedAt: String(row["executed_at"]),
  }));
}