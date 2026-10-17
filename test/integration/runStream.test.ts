import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { createSqliteD1 } from "../support/sqliteD1";
import { createDatabase, type Database } from "@/db";
import { readRunSteps } from "@/db/runLog";
import { insertProposal } from "@/db/actions";
import type { Completion } from "@/agent/tools";
import type { RunEvent } from "@/services/runStream";
import { streamAgentRun } from "@/services/runStream";
import { seedHistory } from "@/services/seedHistory";
import { buildReadModel } from "@/services/readModel";
import { recordUsage } from "@/core/unusedDetector";
import { createD1KvStore } from "@/db/kvStore";

/**
 * The run, streamed.
 *
 * The `complete` function is the one substitution this tier allows — OpenRouter
 * is external and unavailable, and it sits behind the `AGENTS.md` §3 seam. Nothing
 * inside the repo is faked: the agent loop, the detectors, the SQL and the run
 * log are all real.
 *
 * The reason this is a service and not a route handler is testability. SSE
 * formatting is trivial and the interesting behaviour is not — when a step is
 * written, whether the run survives a broken stream, whether the rejections reach
 * the terminal event — and none of it needs a socket to prove.
 */

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const NOW = new Date("2026-10-17T00:00:00.000Z");

let db: Database;

beforeEach(async () => {
  const sqlite = new BetterSqlite3(":memory:");
  db = createDatabase(createSqliteD1(sqlite));
  sqlite.exec(readFileSync(path.join(REPO_ROOT, "src", "db", "schema.sql"), "utf8"));

  await seedHistory(db, { now: NOW });
  await recordUsage(createD1KvStore(db), "sub-netflix", "2026-07-18T00:00:00.000Z");
});

function complete(calls: readonly string[]): () => Promise<Completion> {
  let turn = 0;
  return async () => {
    const name = calls[turn] ?? "stop";
    turn += 1;
    if (name === "stop") {
      return {
        text: "Recommending a refund for the idle subscription.",
        toolCalls: [],
        finishReason: "stop",
        usage: { totalTokens: 30 },
      };
    }
    if (name === "record_proposal") {
      return {
        text: "",
        toolCalls: [
          {
            id: "call-2",
            name: "record_proposal",
            argsError: null,
            args: {
              subId: "sub-netflix",
              action: "refund",
              category: "idle_subscription",
              severity: 4,
              rationale: "No use recorded in three months.",
            },
          },
        ],
        finishReason: "tool_calls",
        usage: { totalTokens: 23 },
      };
    }
    return {
      text: "",
      toolCalls: [{ id: "call-1", name, argsError: null, args: { limit: 5 } }],
      finishReason: "tool_calls",
      usage: { totalTokens: 15 },
    };
  };
}

async function collect(events: AsyncGenerator<RunEvent>): Promise<RunEvent[]> {
  const out: RunEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

/**
 * A failure while writing the proposals must still end the stream.
 *
 * This test exists because of a hang. `insertProposal` can reject — a duplicate
 * primary key is enough, and two runs on a fixed clock both minted
 * `act-<ms>-1` — and the rejection escaped the completion handler, so `close()`
 * was never called and the generator waited on a promise nobody would ever
 * resolve. The screen sat on "Running…" forever.
 *
 * A stream that cannot report its own failure is the worst shape a stream can
 * have, because the failure mode and the success mode look identical from the
 * client: silence.
 */
describe("streamAgentRun closes even when recording proposals fails", () => {
  it("ends with an error rather than waiting forever", async () => {
    const { findings } = await buildReadModel(db, NOW);

    // Force the failure deterministically. Proposal ids are `act-<runId>-<n>`
    // with the counter starting at 1, so the first proposal of a run has a
    // predictable id — pre-insert it and `insertProposal` will collide on the
    // primary key and reject.
    //
    // The first version of this test re-ran the same run twice and expected a
    // collision, which stopped happening the moment ids became unique. It passed
    // for the wrong reason: nothing failed, so `close()` was reached normally and
    // the test proved nothing about the failure path at all.
    await insertProposal(
      db,
      {
        id: "act-run-collide-1",
        runId: null,
        kind: "refund",
        targetId: "sub-netflix",
        amountCents: 1_599,
        currency: "USD",
        rationale: "already here",
        evidence: null,
      },
      () => NOW.toISOString(),
    );

    const events = await collect(
      streamAgentRun({
        db,
        runId: "run-collide",
        findings,
        complete: complete(["list_findings", "record_proposal"]),
        now: NOW,
      }),
    );

    const last = events[events.length - 1];
    expect(last?.type).toBe("error");
    if (last?.type !== "error") return;
    // The reason says what actually went wrong, so the screen can show it rather
    // than going quiet.
    expect(last.message).toMatch(/could not be recorded/i);
  }, 15_000);

  it("gives two runs different proposal ids, because a clock is not a unique key", async () => {
    // `now` is injected for determinism, so two runs share it exactly. An id built
    // from the clock alone therefore collides, and the second run's insert dies on
    // the primary key — which is a bug that only appears in tests with a fixed
    // clock and never in a demo, where the clock moves. Exactly the kind of thing
    // that is cheapest to find here.
    const { findings } = await buildReadModel(db, NOW);
    const a = await collect(
      streamAgentRun({
        db,
        runId: "run-1",
        findings,
        complete: complete(["list_findings", "record_proposal"]),
        now: NOW,
      }),
    );
    const b = await collect(
      streamAgentRun({
        db,
        runId: "run-2",
        findings,
        complete: complete(["list_findings", "record_proposal"]),
        now: NOW,
      }),
    );

    const idsOf = (events: RunEvent[]) =>
      events.flatMap((e) => (e.type === "done" ? e.proposals.map((p) => p.id) : []));
    const idsA = idsOf(a);
    const idsB = idsOf(b);

    expect(idsA.length).toBeGreaterThan(0);
    expect(idsB.length).toBeGreaterThan(0);
    // A shared id would make the second run's proposal overwrite the first.
    expect(new Set([...idsA, ...idsB]).size).toBe(idsA.length + idsB.length);
  }, 15_000);
});

describe("streamAgentRun", () => {
  it("puts the terminal event last, always", async () => {
    // The property the first version got wrong. A step write is awaited inside
    // the loop's observer, so those writes settle out of order relative to the
    // run — and enqueueing `done` the moment the run resolved produced
    // `step, done, step, step`. The client reducer treats `done` as terminal, so
    // every run silently lost its last steps on screen.
    const { findings } = await buildReadModel(db, NOW);
    const events = await collect(
      streamAgentRun({
        db,
        runId: "run-1",
        findings,
        complete: complete(["list_findings", "record_proposal"]),
        now: NOW,
      }),
    );

    const doneIndexes = events
      .map((e, i) => (e.type === "done" ? i : -1))
      .filter((i) => i >= 0);
    expect(doneIndexes).toEqual([events.length - 1]);
  });

  it("emits a step for every turn and a terminal done event", async () => {
    const { findings } = await buildReadModel(db, NOW);
    const events = await collect(
      streamAgentRun({
        db,
        runId: "run-1",
        findings,
        complete: complete(["list_findings", "record_proposal"]),
        now: NOW,
      }),
    );

    expect(events[events.length - 1]?.type).toBe("done");
    expect(events.filter((e) => e.type === "step").length).toBeGreaterThan(1);
  });

  it("emits steps in increasing seq, so the client can order without trusting arrival", async () => {
    const { findings } = await buildReadModel(db, NOW);
    const events = await collect(
      streamAgentRun({
        db,
        runId: "run-1",
        findings,
        complete: complete(["list_findings", "record_proposal"]),
        now: NOW,
      }),
    );

    const seqs = events.flatMap((e) => (e.type === "step" ? [e.step.seq] : []));
    expect(seqs).toEqual(seqs.slice().sort((a, b) => a - b));
  });

  it("persists every emitted step to the run log, because the stream is not the record", async () => {
    // The stream is a view. D1 is the audit trail — the judge who asks "what did
    // the agent actually do" reads the table, and a replay after the fact has to
    // show the same steps the screen showed.
    const { findings } = await buildReadModel(db, NOW);
    const events = await collect(
      streamAgentRun({
        db,
        runId: "run-1",
        findings,
        complete: complete(["list_findings", "record_proposal"]),
        now: NOW,
      }),
    );

    const emitted = events.filter((e) => e.type === "step").length;
    const stored = await readRunSteps(db, "run-1");

    expect(stored).toHaveLength(emitted);
    expect(stored.map((s) => s.seq)).toEqual(stored.map((s) => s.seq).slice().sort((a, b) => a - b));
  });

  it("carries the rejections into the terminal event, not just the log", async () => {
    // `AGENTS.md`: the run log is the artefact a judge watches, so "the agent is
    // constrained" has to be visible. A rejection that only reached the steps
    // would vanish the moment the log scrolled past.
    const { findings } = await buildReadModel(db, NOW);
    const events = await collect(
      streamAgentRun({
        db,
        runId: "run-1",
        findings,
        complete: complete(["delete_everything"]),
        now: NOW,
      }),
    );

    const done = events[events.length - 1];
    expect(done?.type).toBe("done");
    if (done?.type !== "done") return;
    expect(done.rejections.length).toBeGreaterThan(0);
    expect(done.rejections[0]?.reason).toBe("not on the allowlist");
  });

  it("reports how the run stopped, because a turn cap is not the same as an answer", async () => {
    const { findings } = await buildReadModel(db, NOW);
    const events = await collect(
      streamAgentRun({
        db,
        runId: "run-1",
        findings,
        // Never stops calling a tool, so the cap is what ends it.
        complete: () =>
          Promise.resolve({
            text: "",
            toolCalls: [{ id: "c", name: "list_findings", argsError: null, args: { limit: 1 } }],
            finishReason: "tool_calls",
            usage: { totalTokens: 5 },
          }),
        now: NOW,
        maxTurns: 2,
      }),
    );

    const done = events[events.length - 1];
    expect(done?.type).toBe("done");
    if (done?.type !== "done") return;
    expect(done.stoppedBecause).toBe("turn_cap");
  });

  it("emits an error event and still finishes, rather than throwing into the stream", async () => {
    // A throw here would surface as a broken `EventSource` and a dead screen. The
    // steps already written stay written, which is the whole point of persisting
    // them before emitting.
    const { findings } = await buildReadModel(db, NOW);
    const events = await collect(
      streamAgentRun({
        db,
        runId: "run-1",
        findings,
        complete: () => Promise.reject(new Error("OpenRouter 502")),
        now: NOW,
      }),
    );

    const last = events[events.length - 1];
    expect(last?.type).toBe("error");
    if (last?.type !== "error") return;
    expect(last.message).toMatch(/OpenRouter/);
  });

  it("never writes a step for a run it did not create", async () => {
    // Two concurrent runs must not interleave sequences: `run_steps` is keyed on
    // (run_id, seq) and a collision is a constraint violation that would take
    // down one of them mid-demo.
    const { findings } = await buildReadModel(db, NOW);
    await collect(
      streamAgentRun({
        db,
        runId: "run-a",
        findings,
        complete: complete(["list_findings", "record_proposal"]),
        now: NOW,
      }),
    );
    const other = await collect(
      streamAgentRun({
        db,
        runId: "run-b",
        findings,
        complete: complete(["list_findings", "record_proposal"]),
        now: NOW,
      }),
    );

    const bSteps = other.filter((e) => e.type === "step");
    expect(bSteps[0]?.type === "step" && bSteps[0].step.seq).toBe(1);
    expect(await readRunSteps(db, "run-a")).not.toHaveLength(0);
  });

  it("gives the agent findings and nothing else to reason about", async () => {
    // The agent's input is the detector output. If this widened — to raw
    // transactions, to the merchant list — the run would stop being auditable
    // against the findings the screen shows above it.
    const { findings } = await buildReadModel(db, NOW);
    let seen: number | null = null;

    await collect(
      streamAgentRun({
        db,
        runId: "run-1",
        findings,
        complete: (request) => {
          seen = request.messages.length;
          return Promise.resolve({
            text: "done",
            toolCalls: [],
            finishReason: "stop",
            usage: { totalTokens: 1 },
          });
        },
        now: NOW,
      }),
    );

    // system prompt plus one brief, and nothing appended before the first call.
    expect(seen).toBe(2);
  });
});
