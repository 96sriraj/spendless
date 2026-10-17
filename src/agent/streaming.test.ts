import { describe, expect, it } from "vitest";
import { runAgent } from "./agent";
import type { ChatMessage, Completion, ToolCall } from "./tools";
import type { Recommendation } from "@/core/insights";
import type { TranscriptEntry } from "./proposal";

/**
 * The streaming hook.
 *
 * `runAgent` runs to completion and returns a transcript, which is correct for a
 * test and useless for a screen: a merchant watching a button press learns
 * nothing for the eight seconds the model takes to answer, and "nothing happened
 * for eight seconds" is indistinguishable from a hung request.
 *
 * So the loop reports each entry as it happens. That is the whole of it — one
 * optional callback, no change to what the agent may do, and nothing about the
 * run's outcome depending on whether anyone is listening.
 *
 * ---------------------------------------------------------------------------
 * NOTE ON FIXTURES
 * ---------------------------------------------------------------------------
 *
 * `ToolCall.argsError` must be present and `null` to mean "parsed cleanly". It is
 * checked with `!== null`, so omitting the field rejects the call — and these
 * fixtures spent a while debugging a "arguments did not match the tool schema"
 * rejection that was really a missing key. `bun run typecheck` catches it; a
 * bare `vitest` run does not.
 */

const FINDINGS: readonly Recommendation[] = [
  {
    kind: "unused",
    subId: "sub-netflix",
    title: "sub-netflix looks unused",
    subtitle: "Last used 91 days ago",
    savingCents: 1_599,
    cta: "Consider cancel",
    confidence: 0.4,
  },
];

type Step = TranscriptEntry & { readonly seq: number };

function call(partial: Omit<ToolCall, "argsError">): ToolCall {
  return { argsError: null, ...partial };
}

function completion(
  toolCalls: readonly ToolCall[],
  text = "",
  totalTokens = 15,
): Completion {
  return {
    text,
    toolCalls,
    finishReason: toolCalls.length > 0 ? "tool_calls" : "stop",
    usage: { totalTokens },
  };
}

/**
 * Reads the findings, then proposes. Two tool turns, then an answer — the shape a
 * real run takes, and the only shape that produces a `tool_result` step: that row
 * is emitted by `onPropose`, so a run that only ever reads would show the screen
 * a call and no consequence.
 */
function scripted(): (request: { messages: readonly ChatMessage[] }) => Promise<Completion> {
  let turn = 0;
  return async () => {
    turn += 1;
    if (turn === 1) {
      return completion([call({ id: "call-1", name: "list_findings", args: { limit: 5 } })]);
    }
    if (turn === 2) {
      return completion([
        call({
          id: "call-2",
          name: "record_proposal",
          args: {
            subId: "sub-netflix",
            action: "refund",
            category: "idle_subscription",
            severity: 4,
            rationale: "No use recorded in three months.",
          },
        }),
      ]);
    }
    return completion([], "Proposing a refund for the unused subscription.", 30);
  };
}

function collect(): {
  steps: Step[];
  onStep: (entry: TranscriptEntry, seq: number) => void;
} {
  const steps: Step[] = [];
  return {
    steps,
    onStep: (entry, seq) => {
      steps.push({ ...entry, seq });
    },
  };
}

/** Tools named in a requesting turn's payload. */
function requestedTools(step: Step | undefined): string[] {
  if (step === undefined || step.kind !== "llm_call") return [];
  const payload = step.payload as { toolCalls?: string[] } | undefined;
  return payload?.toolCalls ?? [];
}

describe("runAgent onStep", () => {
  it("reports every transcript entry as it happens, in order", async () => {
    const { steps, onStep } = collect();
    await runAgent({ findings: FINDINGS, complete: scripted(), onStep });

    expect(steps.length).toBeGreaterThan(1);
    // Monotonic sequence numbers. The run log orders steps on these because
    // stream delivery order is not guaranteed, so a repeat would be
    // indistinguishable from a duplicate delivery.
    const seqs = steps.map((s) => s.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  /**
   * The ordering the run log depends on.
   *
   * This first asserted a distinct `tool_call` step preceding its `tool_result`.
   * There is no such step: `TranscriptEntry` declares the kind, but the loop
   * records the requesting turn as an `llm_call` whose payload names the tools.
   * One row per turn, not one per tool call — so the guarantee worth pinning is
   * that the requesting turn reaches the log before anything it caused.
   */
  it("reports the requesting turn before the result it produced", async () => {
    const { steps, onStep } = collect();
    await runAgent({ findings: FINDINGS, complete: scripted(), onStep });

    const requestIndex = steps.findIndex((s) => requestedTools(s).length > 0);
    const resultIndex = steps.findIndex((s) => s.kind === "tool_result");

    expect(requestIndex).toBeGreaterThanOrEqual(0);
    expect(resultIndex).toBeGreaterThan(requestIndex);
  });

  it("names the tools the model asked for, because the allowlist is the story", async () => {
    // The demo's argument is "the agent is constrained". The screen has to be
    // able to show *what* it called, and the requesting turn's payload is the
    // only place that is recorded.
    const { steps, onStep } = collect();
    await runAgent({ findings: FINDINGS, complete: scripted(), onStep });

    const names = steps.filter((s) => requestedTools(s).length > 0).flatMap(requestedTools);
    expect(names).toEqual(["list_findings", "record_proposal"]);
  });

  it("reports rejections, because a refusal the screen cannot show is a refusal nobody can audit", async () => {
    // `AGENTS.md`: "Every rejection is recorded, not thrown… so 'the agent is
    // constrained' has to be visible on screen rather than asserted in a
    // comment." The run log is what a judge watches.
    const { steps, onStep } = collect();
    const run = await runAgent({
      findings: FINDINGS,
      complete: async () =>
        completion([call({ id: "c", name: "delete_everything", args: {} })]),
      onStep,
    });

    expect(steps.some((s) => s.kind === "rejected")).toBe(true);
    expect(run.rejections.length).toBeGreaterThan(0);
  });

  it("never lets the model state an amount, because the schema forbids it", async () => {
    // The no-money rule is a schema, not a prompt. A proposal carrying a figure is
    // rejected whatever the model was told — and the rejection has to reach the
    // log, because that is the visible proof the rule is enforced rather than
    // requested.
    const { steps, onStep } = collect();
    const run = await runAgent({
      findings: FINDINGS,
      complete: async () =>
        completion([
          call({
            id: "c",
            name: "record_proposal",
            args: {
              subId: "sub-netflix",
              action: "refund",
              category: "idle_subscription",
              severity: 4,
              rationale: "Refund $15.99 please.",
              amountCents: 1_599,
            },
          }),
        ]),
      onStep,
    });

    expect(run.proposals).toHaveLength(0);
    expect(run.rejections.length).toBeGreaterThan(0);
    expect(steps.some((s) => s.kind === "rejected")).toBe(true);
  });

  it("keeps running when the observer throws, because the log outlives the socket", async () => {
    // The client disconnecting mid-run must not abort the work: the transcript
    // still goes to D1, and a half-finished run is worse than a completed one
    // nobody is watching. Swallowing is safe *because* the run is persisted —
    // without that it would be losing data silently.
    let calls = 0;
    const run = await runAgent({
      findings: FINDINGS,
      complete: scripted(),
      onStep: () => {
        calls += 1;
        throw new Error("socket closed");
      },
    });

    expect(calls).toBeGreaterThan(0);
    expect(run.stoppedBecause).toBe("answered");
    expect(run.proposals).toHaveLength(1);
    expect(run.transcript.length).toBeGreaterThan(0);
  });

  it("produces an identical run whether or not anyone is listening", async () => {
    // A streaming hook that could influence the loop would mean the demo showed
    // something the batch path does not.
    const quiet = await runAgent({ findings: FINDINGS, complete: scripted() });
    const { onStep } = collect();
    const watched = await runAgent({ findings: FINDINGS, complete: scripted(), onStep });

    expect(watched.proposals).toEqual(quiet.proposals);
    expect(watched.rejections).toEqual(quiet.rejections);
    expect(watched.turns).toBe(quiet.turns);
    expect(watched.finalText).toBe(quiet.finalText);
    expect(watched.transcript).toEqual(quiet.transcript);
  });

  it("never lets the model's closing words carry an invented link", async () => {
    // `CancelGuidance` refuses URLs as a schema, but `finalText` is free text and
    // never passes through it. A live run produced
    // "[Cancel your membership](https://help.netflix.com/en/node/435)" as its
    // answer and streamed it to the screen — the one place the repo's own "a
    // link that 404s is worse than no link" rule did not reach. The words are
    // kept; the link is not.
    const run = await runAgent({
      findings: FINDINGS,
      complete: async () =>
        completion(
          [],
          "Netflix: [Cancel your membership](https://help.netflix.com/en/node/435) — then confirm.",
        ),
    });

    expect(run.finalText).not.toMatch(/https?:/i);
    // The part that is true survives, because dropping the whole sentence would
    // leave a run log that teaches nobody.
    expect(run.finalText).toContain("Cancel your membership");
  });

  it("streams exactly as many entries as the transcript holds", async () => {
    // The regression guard for the centralised `record` helper. `runAgent` has
    // four transcript write sites and a fifth is a plausible future change; one
    // written as `transcript.push` would compile, pass every behavioural test,
    // and quietly never appear on screen. Counting is what catches it.
    const { steps, onStep } = collect();
    const run = await runAgent({ findings: FINDINGS, complete: scripted(), onStep });

    expect(steps.length).toBe(run.transcript.length);
    expect(steps.map((s) => s.label)).toEqual(run.transcript.map((t) => t.label));
  });
});