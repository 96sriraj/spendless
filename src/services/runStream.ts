/**
 * The run, streamed.
 *
 * ---------------------------------------------------------------------------
 * WHY THE STREAM IS A SERVICE AND NOT A ROUTE HANDLER
 * ---------------------------------------------------------------------------
 *
 * SSE framing is the least interesting part of this feature, and the interesting
 * parts are all invisible from a route: when a step is written, whether the
 * terminal event carries the rejections, what happens when the model call throws.
 *
 * Putting the loop here means those are tested against real SQL and the real
 * agent, with only `complete` substituted — which is the one substitution
 * `AGENTS.md` permits in this tier, because OpenRouter is external and this
 * function sits behind the §3 seam. The route becomes a formatter.
 *
 * ---------------------------------------------------------------------------
 * THE STREAM IS A VIEW. D1 IS THE RECORD.
 * ---------------------------------------------------------------------------
 *
 * Every step is persisted *before* it is emitted. That ordering is the whole
 * reason a failed run is still auditable: the judge who asks "what did the agent
 * actually do" reads the table, and the screen and the replay show the same
 * steps. The reverse order — emit, then hope the write lands — would mean a
 * crash mid-stream produced a log the screen showed and the database did not have.
 *
 * ---------------------------------------------------------------------------
 * FAILURES ARE EVENTS
 * ---------------------------------------------------------------------------
 *
 * A rejected model call becomes an `error` event and a finished stream, not a
 * thrown exception. A throw here tears down the `EventSource`, and the screen
 * goes blank at the exact moment something went wrong — the moment it most needs
 * to say so.
 */

import { runAgent } from "@/agent/agent";
import type { Proposal } from "@/agent/proposal";
import type { ChatMessage, Completion, ToolSpec } from "@/agent/tools";
import type { Recommendation } from "@/core/insights";
import type { Database } from "@/db";
import { appendRunStep } from "@/db/runLog";
import { recordAgentProposals } from "@/services/actions";

export type RunStepKind = "llm_call" | "tool_call" | "tool_result" | "rejected";

export type RunEvent =
  | {
      readonly type: "step";
      readonly step: {
        readonly seq: number;
        readonly turn: number;
        readonly kind: RunStepKind;
        readonly label: string;
        readonly payload?: unknown;
      };
    }
  | {
      readonly type: "done";
      /**
       * What is now approvable.
       *
       * `id` and `amountCents` are here because this is a row the screen acts on,
       * not the model's opinion. `amountCents` is resolved from `savingCents` in
       * the core and is null for a cancellation, which moves no money.
       */
      readonly proposals: readonly {
        readonly id: string;
        readonly subId: string;
        readonly kind: string;
        readonly action: string;
        readonly rationale: string;
        readonly severity: number;
        readonly category: string;
        readonly amountCents: number | null;
        readonly currency: string;
        readonly status: string;
      }[];
      /** Agent proposals that could not become rows, so the log can show them. */
      readonly rejected: readonly string[];
      readonly rejections: readonly {
        readonly toolName: string;
        readonly reason: string;
        readonly detail: string;
        readonly turn: number;
      }[];
      readonly turns: number;
      readonly stoppedBecause: "answered" | "turn_cap";
      readonly finalText: string;
    }
  | { readonly type: "error"; readonly message: string };

export type StreamOptions = {
  readonly db: Database;
  readonly runId: string;
  /** The detector output, and the agent's entire view of the world. */
  readonly findings: readonly Recommendation[];
  /** The §3 seam. Substituted in tests; the real OpenRouter client in production. */
  readonly complete: (request: {
    messages: readonly ChatMessage[];
    tools?: readonly ToolSpec[];
  }) => Promise<Completion>;
  readonly now: Date;
  readonly maxTurns?: number;
};

export async function* streamAgentRun(options: StreamOptions): AsyncGenerator<RunEvent> {
  const { db, runId, now } = options;

  // `runAgent` is a plain async function with no notion of a consumer and should
  // not grow one, so the loop writes into a queue and this generator drains it.
  //
  // ---------------------------------------------------------------------------
  // WHY THE TERMINAL EVENT IS HELD BACK
  // ---------------------------------------------------------------------------
  //
  // A step is persisted with `await` inside the loop's observer, so those writes
  // complete out of order relative to the run itself. The first version enqueued
  // `done` the moment `runAgent` resolved, and the stream came out as
  //
  //     step 1, done, step 2, step 3
  //
  // — a run log that declares itself finished and then keeps going. The client
  // reducer treats `done` as terminal and drops everything after it, so the last
  // two steps of every run would have been silently discarded. `runSettled` and
  // `closed` are therefore separate flags: the run can be over while the drain
  // loop is still owed steps.
  //
  // Persisted *before* emitted, always: a screen must never show a step the audit
  // trail does not have.
  const queue: RunEvent[] = [];
  const pending: Promise<unknown>[] = [];
  let release: (() => void) | null = null;
  let closed = false;

  const wake = (): void => {
    release?.();
    release = null;
  };

  const notify = (event: RunEvent): void => {
    queue.push(event);
    wake();
  };

  const close = (event: RunEvent): void => {
    notify(event);
    closed = true;
    wake();
  };

  const run = runAgent({
    findings: options.findings,
    complete: options.complete,
    ...(options.maxTurns === undefined ? {} : { maxTurns: options.maxTurns }),
    onStep: (entry, seq) => {
      const event: RunEvent = { type: "step", step: { seq, ...entry } };
      pending.push(
        appendRunStep(db, {
          runId,
          seq,
          kind: entry.kind,
          label: entry.label,
          ...(entry.payload === undefined ? {} : { payload: entry.payload }),
          createdAt: now.toISOString(),
        }).then(
          // Wrapped, not passed by reference: `.then(notify)` would hand `notify`
          // the *resolved value* of `appendRunStep` — `undefined` — and push
          // `undefined` onto the queue. The event has to be closed over.
          () => notify(event),
          (error: unknown) =>
            notify({
              type: "error",
              message: `could not record a run step: ${
                error instanceof Error ? error.message : String(error)
              }`,
            }),
        ),
      );
    },
  });

  void run.then(
    async (result) => {
      // Every step write the loop issued, awaited. `runAgent` cannot emit again
      // once it has resolved, so this set is complete by now.
      await Promise.all(pending);

      try {
        /**
         * The agent's proposals become approvable rows here, and this was the
         * missing line: the run produced proposals that nothing wrote anywhere, so
         * after a run the screen had a proposal and nothing to approve.
         *
         * The amount on each row is resolved from `savingCents` in the core — the
         * proposal itself carries no figure and the schema would reject one.
         */
        const recorded = await recordAgentProposals({
          db,
          agentProposals: result.proposals,
          findings: options.findings,
          now,
          runId,
          idPrefix: runId,
        });

        close({
          type: "done",
          proposals: recorded.recorded.map((row) => ({
            id: row.id,
            subId: row.targetId ?? "",
            kind: row.kind,
            action: agentActionFor(result.proposals, row.targetId),
            rationale: row.rationale ?? "",
            severity: agentSeverityFor(result.proposals, row.targetId),
            category: agentCategoryFor(result.proposals, row.targetId),
            // Null for a cancellation: it moves no money, and `0` would read as
            // "refunded nothing" beside a capture that had just been charged.
            amountCents: row.amountCents,
            currency: row.currency,
            status: row.status,
          })),
          rejected: recorded.refused.map((r) => `${r.subId}: ${r.reason}`),
          rejections: result.rejections,
          turns: result.turns,
          stoppedBecause: result.stoppedBecause,
          finalText: result.finalText,
        });
      } catch (error: unknown) {
        // The reason this is a `try` and not a `catch` bolted on afterwards.
        // `insertProposal` can reject — a primary-key collision is enough — and
        // when it did the rejection escaped this handler entirely, `close()` was
        // never reached, and the generator waited on a promise nobody would ever
        // resolve. The screen sat on "Running…" forever.
        //
        // A stream that cannot report its own failure is the worst shape a stream
        // can have: from the client, silence and success look identical.
        close({
          type: "error",
          message: `the run finished but its proposals could not be recorded: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      }
    },
    async (error: unknown) => {
      await Promise.all(pending);
      close({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    },
  );

  // Drain until the run has settled AND everything it produced has been handed
  // over. `runSettled` alone is not enough — see the header.
  for (;;) {
    while (queue.length > 0) {
      yield queue.shift()!;
    }
    if (closed && queue.length === 0) return;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  }
}

/**
 * The agent's own framing of a proposal, carried alongside the row.
 *
 * The row is authoritative for the money — `amountCents` comes from the finding,
 * never from here. These are the model's own words about severity and category,
 * kept because the run log is supposed to show what the agent thought, and a row
 * stripped of the model's reasoning shows only what the core decided.
 *
 * Defaults are honest refusals rather than zeroes: a row with no matching
 * proposal says "investigate" and severity 0, which reads as "not urgent",
 * instead of inventing a confident answer.
 */
function agentActionFor(proposals: readonly Proposal[], subId: string | null): string {
  return proposals.find((p) => p.subId === subId)?.action ?? "investigate";
}

function agentSeverityFor(proposals: readonly Proposal[], subId: string | null): number {
  return proposals.find((p) => p.subId === subId)?.severity ?? 0;
}

function agentCategoryFor(proposals: readonly Proposal[], subId: string | null): string {
  return proposals.find((p) => p.subId === subId)?.category ?? "healthy";
}

/**
 * A fresh run id.
 *
 * Prefixed so a run is identifiable in a D1 browser at 11pm during a demo without
 * a query. Not a UUID library — there is no need for one here and
 * `AGENTS.md` will not take a dependency for an id.
 *
 * The clock alone is not unique: two runs in the same millisecond would collide,
 * and the run id is also the discriminator for proposal ids (see `idPrefix`).
 * `AGENTS.md` will not take a dependency for that either, so the counter below is
 * module-scoped and monotonic.
 */
let runCounter = 0;

export function newRunId(now: Date): string {
  runCounter += 1;
  return `run-${now.toISOString().replace(/[^0-9]/g, "").slice(0, 14)}-${runCounter}`;
}
