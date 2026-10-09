/**
 * Run log — every LLM call, tool call and result, persisted in order.
 *
 * ARCHITECTURE.md section 9 calls this the demo multiplier: judges judge from
 * a video, and without a replayable record of the agent's behaviour they have
 * to take its reasoning on trust. With it, the behaviour *is* the demo.
 *
 * Phase 4 (todo.md P4-02) grows this from raw persistence to a rendered
 * timeline. The storage contract comes first so the demo has a spine to grow
 * into, and so the end-to-end tier has something real to assert against.
 */

import type { Database } from "./index";

export const RUN_STEP_KINDS = ["llm_call", "tool_call", "tool_result", "note"] as const;
export type RunStepKind = (typeof RUN_STEP_KINDS)[number];

export type RunStep = {
  readonly runId: string;
  readonly seq: number;
  readonly kind: RunStepKind;
  readonly label: string;
  /** Structured detail. Optional - a note needs none. */
  readonly payload?: unknown;
  readonly durationMs?: number | null;
  readonly createdAt?: string;
};

export type ReplayedStep = {
  readonly seq: number;
  readonly kind: RunStepKind;
  readonly label: string;
  readonly payload: unknown;
  readonly durationMs: number | null;
  readonly createdAt: string;
};

/** Next sequence number for a run. Starts at 1. */
export async function nextSeq(db: Database, runId: string): Promise<number> {
  const row = await db.get<{ next: number | null }>(
    "SELECT MAX(seq) AS next FROM run_steps WHERE run_id = ?",
    runId,
  );
  return (row?.next ?? 0) + 1;
}

export async function appendRunStep(
  db: Database,
  step: RunStep,
  now: () => string = () => new Date().toISOString(),
): Promise<void> {
  if (!RUN_STEP_KINDS.includes(step.kind)) {
    throw new Error(`Unknown run step kind: ${String(step.kind)}`);
  }
  await db.run(
    `INSERT INTO run_steps (run_id, seq, kind, label, payload, duration_ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    step.runId,
    step.seq,
    step.kind,
    step.label,
    step.payload === undefined ? null : JSON.stringify(step.payload),
    step.durationMs ?? null,
    step.createdAt ?? now(),
  );
}

/**
 * Read a run back in the order it happened.
 *
 * ORDER BY seq, not by timestamp: two steps can land inside the same
 * millisecond, and a timeline that reorders them misrepresents the agent's
 * reasoning. The UNIQUE (run_id, seq) constraint is what makes this total.
 */
export async function readRunSteps(db: Database, runId: string): Promise<ReplayedStep[]> {
  const rows = await db.all<{
    seq: number;
    kind: string;
    label: string;
    payload: string | null;
    duration_ms: number | null;
    created_at: string;
  }>(
    `SELECT seq, kind, label, payload, duration_ms, created_at
     FROM run_steps WHERE run_id = ? ORDER BY seq`,
    runId,
  );

  return rows.map((row) => ({
    seq: row.seq,
    kind: row.kind as RunStepKind,
    label: row.label,
    payload: row.payload === null ? null : JSON.parse(row.payload),
    durationMs: row.duration_ms,
    createdAt: row.created_at,
  }));
}