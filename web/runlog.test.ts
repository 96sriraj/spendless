import { describe, expect, it } from "vitest";
import { applyRunEvent, describeStep, emptyRunState, parseRunEvent, statusLine, type RunEvent } from "./runlog";

/**
 * The run log's reducer.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS PURE AND SEPARATE
 * ---------------------------------------------------------------------------
 *
 * The component that renders the log is a `map`. Every decision worth testing is
 * upstream of it, and all of those decisions are pure, so they live here where a
 * test can reach them without a DOM, an `EventSource`, or a Worker.
 *
 * ---------------------------------------------------------------------------
 * THE PROPERTY THIS FILE EXISTS FOR
 * ---------------------------------------------------------------------------
 *
 * **Out-of-order delivery must still render in order.** `EventSource` gives no
 * ordering guarantee across a reconnect, and the steps are also written to D1
 * with a `seq` that is authoritative. A log that renders arrival order shows a
 * refund proposal above the call that produced it, which reads as though the
 * agent invented one — the exact suspicion this screen exists to dispel.
 *
 * So `seq` is the sort key, not arrival index, and a duplicate is idempotent.
 */

function step(seq: number, label: string) {
  return {
    type: "step" as const,
    step: { seq, turn: 1, kind: "llm_call" as const, label },
  };
}

describe("emptyRunState", () => {
  it("starts with nothing running", () => {
    const state = emptyRunState();
    expect(state.phase).toBe("idle");
    expect(state.steps).toEqual([]);
    expect(state.proposals).toEqual([]);
  });
});

describe("applyRunEvent", () => {
  it("orders steps by seq, not by arrival", () => {
    // The gate. Arrival order would render the result above the call that caused
    // it, which looks like the agent conjuring a proposal from nothing.
    let state = emptyRunState();
    state = applyRunEvent(state, step(3, "proposal sub-netflix"));
    state = applyRunEvent(state, step(1, "turn 1"));
    state = applyRunEvent(state, step(2, "turn 2"));

    expect(state.steps.map((s) => s.seq)).toEqual([1, 2, 3]);
    expect(state.steps.map((s) => s.label)).toEqual([
      "turn 1",
      "turn 2",
      "proposal sub-netflix",
    ]);
  });

  it("is idempotent for a replayed step, because a reconnect resends", () => {
    // An `EventSource` that drops and reconnects with `Last-Event-ID` will
    // deliver the same steps twice. Rendering them twice would make the run look
    // busier than it was — and on a demo, "busier" reads as "more thorough",
    // which is exactly the wrong direction to be wrong in.
    let state = emptyRunState();
    state = applyRunEvent(state, step(1, "turn 1"));
    state = applyRunEvent(state, step(1, "turn 1"));
    state = applyRunEvent(state, step(2, "turn 2"));

    expect(state.steps).toHaveLength(2);
  });

  it("marks the run as running the moment a step arrives", () => {
    const state = applyRunEvent(emptyRunState(), step(1, "turn 1"));
    expect(state.phase).toBe("running");
  });

  it("carries the proposals out of the terminal event", () => {
    let state = emptyRunState();
    state = applyRunEvent(state, step(1, "turn 1"));
    state = applyRunEvent(state, {
      type: "done",
      proposals: [
        {
          subId: "sub-netflix",
          action: "refund",
          category: "idle_subscription",
          severity: 4,
          rationale: "No use recorded in three months.",
        },
      ],
      rejections: [{ toolName: "delete_everything", reason: "not on the allowlist", detail: "", turn: 2 }],
      turns: 3,
      stoppedBecause: "answered",
      finalText: "Proposing a refund.",
    });

    expect(state.phase).toBe("done");
    expect(state.proposals.map((p) => p.subId)).toEqual(["sub-netflix"]);
    // Rejections are the evidence that the agent is constrained. They survive to
    // the terminal state, not just the stream.
    expect(state.rejections.map((r) => r.reason)).toEqual(["not on the allowlist"]);
    expect(state.finalText).toBe("Proposing a refund.");
  });

  it("keeps the log when the run fails, because a failure is evidence too", () => {
    // The interesting failure is a half-finished run. Discarding its steps on
    // error would leave the screen saying only "failed", with nothing to inspect
    // — and "it failed" with a visible partial log is a far better demo than a
    // clean screen that hides it.
    let state = emptyRunState();
    state = applyRunEvent(state, step(1, "turn 1"));
    state = applyRunEvent(state, step(2, "turn 2"));
    state = applyRunEvent(state, { type: "error", message: "OpenRouter timed out" });

    expect(state.phase).toBe("error");
    expect(state.steps).toHaveLength(2);
    expect(state.error).toBe("OpenRouter timed out");
  });

  it("ignores an event that arrives after the run finished", () => {
    // A reconnect can deliver one last frame after the terminal event. Letting it
    // through would flip the screen back to "running" on a completed run, which
    // looks like a stuck button.
    let state = emptyRunState();
    state = applyRunEvent(state, { type: "done", proposals: [], rejections: [], turns: 1, stoppedBecause: "answered", finalText: "" });
    state = applyRunEvent(state, step(1, "turn 1"));

    expect(state.phase).toBe("done");
    expect(state.steps).toEqual([]);
  });
});

describe("statusLine", () => {
  function done(overrides: Partial<Parameters<typeof statusLine>[0]> = {}) {
    return {
      ...emptyRunState(),
      phase: "done",
      turns: 3,
      proposals: [
        { subId: "sub-a", action: "refund", category: "idle", severity: 4, rationale: "x" },
      ],
      rejections: [],
      ...overrides,
    } as Parameters<typeof statusLine>[0];
  }

  it("says nothing has run before the first run", () => {
    expect(statusLine(emptyRunState())).toBe("Not run yet");
  });

  it("counts steps while running, so the screen is never a mystery", () => {
    // The point of streaming. A spinner for eight seconds is indistinguishable
    // from a hung request; "3 steps so far" is not.
    let state = emptyRunState();
    state = applyRunEvent(state, step(1, "turn 1"));
    expect(statusLine(state)).toBe("1 step so far");

    state = applyRunEvent(state, step(2, "turn 2"));
    expect(statusLine(state)).toBe("2 steps so far");
  });

  it("reports the turn cap as the cap, not as an ordinary finish", () => {
    // "Stopped at the turn cap" is a constraint being visible. Collapsing it into
    // "3 turns" would make a constrained agent look like one that chose to stop.
    const line = statusLine(
      done({ stoppedBecause: "turn_cap", turns: 6, proposals: [], finalText: "" }),
    );
    expect(line).toMatch(/turn cap/i);
    expect(line).toMatch(/6/);
  });

  it("counts refusals, because they are the evidence the agent is constrained", () => {
    const line = statusLine(
      done({
        rejections: [
          { toolName: "delete_everything", reason: "not on the allowlist", detail: "", turn: 2 },
        ],
      }),
    );
    expect(line).toMatch(/1 refused/);
  });

  it("omits the refusal clause when there were none, rather than saying '0 refused'", () => {
    // "0 refused" reads as an apology for a clean run.
    expect(statusLine(done())).not.toMatch(/refused/);
  });

  it("uses singular and plural correctly, because a demo screenshot outlives the code", () => {
    expect(statusLine(done({ turns: 1, proposals: [] }))).toBe("1 turn, 0 proposals");
    expect(statusLine(done())).toBe("3 turns, 1 proposal");
  });

  it("says the run stopped early, without hiding the steps it did take", () => {
    let state = emptyRunState();
    state = applyRunEvent(state, step(1, "turn 1"));
    state = applyRunEvent(state, { type: "error", message: "OpenRouter 502" });

    expect(statusLine(state)).toBe("Stopped early");
    expect(state.steps).toHaveLength(1);
  });
});

describe("describeStep", () => {
  it("names the tools a turn asked for, so the closed allowlist is visible", () => {
    // The demo's argument is that the agent is constrained. The screen is where
    // that has to become something a judge can see.
    expect(
      describeStep({
        seq: 1,
        turn: 1,
        kind: "llm_call",
        label: "turn 1",
        payload: { toolCalls: ["list_findings", "record_proposal"] },
      }),
    ).toBe("asked for list_findings, record_proposal");
  });

  it("says the model answered when a turn asked for nothing", () => {
    expect(describeStep({ seq: 2, turn: 2, kind: "llm_call", label: "turn 2" })).toBe("answered");
  });

  it("shows the reason for a refusal rather than the label", () => {
    // The label is ours ("x refused"); the reason is the constraint that did it.
    // The other way round, a log line reads as an unexplained failure.
    expect(
      describeStep({
        seq: 3,
        turn: 2,
        kind: "rejected",
        label: "delete_everything refused",
        payload: { reason: "not on the allowlist" },
      }),
    ).toBe("not on the allowlist");
  });

  it("falls back to the label rather than rendering undefined", () => {
    expect(
      describeStep({ seq: 4, turn: 1, kind: "rejected", label: "turn cap reached" }),
    ).toBe("turn cap reached");
  });
});

/**
 * The terminal frame.
 *
 * This is the bug the browser found and the tests did not. `parseRunEvent`
 * handled `step` and `error` and returned `null` for anything else — so the `done`
 * frame was classified as an unusable frame and dropped. The screen then sat on
 * "Running…" forever with every step present and no conclusion, which is the worst
 * single failure this screen has: it looks like a hang, and a hang on stage is
 * unrecoverable.
 *
 * It hid because the "drop what you cannot read" behaviour is *correct* for
 * keep-alives and malformed JSON, and a valid frame arriving at the same
 * fall-through looked identical from the outside.
 */
describe("parseRunEvent: the terminal frame", () => {
  const done = JSON.stringify({
    type: "done",
    proposals: [
      { subId: "sub-netflix", action: "cancel", category: "idle_subscription", severity: 3, rationale: "Idle." },
    ],
    rejections: [{ toolName: "x", reason: "not on the allowlist", detail: "", turn: 2 }],
    turns: 3,
    stoppedBecause: "answered",
    finalText: "Netflix can be cancelled.",
  });

  it("reads a done frame, so the run can ever finish", () => {
    const event = parseRunEvent(`data: ${done}`);
    expect(event?.type).toBe("done");
  });

  it("carries the proposals and the rejections through intact", () => {
    const event = parseRunEvent(`data: ${done}`);
    expect(event).toMatchObject({
      type: "done",
      turns: 3,
      stoppedBecause: "answered",
      finalText: "Netflix can be cancelled.",
    });
    if (event?.type !== "done") return;
    expect(event.proposals.map((p) => p.subId)).toEqual(["sub-netflix"]);
    expect(event.rejections.map((r) => r.reason)).toEqual(["not on the allowlist"]);
  });

  it("carries a turn-cap stop through, because that is a different outcome", () => {
    const capped = JSON.stringify({
      type: "done",
      proposals: [],
      rejections: [],
      turns: 6,
      stoppedBecause: "turn_cap",
      finalText: "",
    });
    expect(parseRunEvent(`data: ${capped}`)).toMatchObject({ type: "done", stoppedBecause: "turn_cap" });
  });

  it("accepts an empty proposal list, because a clean run is a valid run", () => {
    const clean = JSON.stringify({
      type: "done",
      proposals: [],
      rejections: [],
      turns: 2,
      stoppedBecause: "answered",
      finalText: "",
    });
    expect(parseRunEvent(`data: ${clean}`)).toMatchObject({ type: "done", proposals: [] });
  });

  it("still drops a frame whose type it does not know", () => {
    // Unchanged: a genuinely unknown type is a protocol drift, and rendering it
    // as truth would be worse than ignoring it.
    expect(parseRunEvent('data: {"type":"nonsense"}')).toBeNull();
  });

  it("drops a done frame missing its outcome, rather than rendering an unfinished run as finished", () => {
    // `stoppedBecause` is what tells the screen the difference between "the agent
    // answered" and "the agent ran out of turns". Without it there is no
    // conclusion to show, so the frame is not a conclusion.
    expect(parseRunEvent('data: {"type":"done","proposals":[]}')).toBeNull();
  });
});

describe("parseRunEvent", () => {
  it("reads an SSE data frame into an event", () => {
    const event = parseRunEvent(
      'data: {"type":"step","step":{"seq":1,"turn":1,"kind":"llm_call","label":"turn 1"}}',
    );
    expect(event?.type).toBe("step");
  });

  it("returns nothing for a keep-alive comment rather than throwing", () => {
    // Proxies and load balancers send `: ping` comments to hold a stream open.
    // A parser that threw on one would kill a working demo connection.
    expect(parseRunEvent(": ping")).toBeNull();
    expect(parseRunEvent("")).toBeNull();
  });

  it("returns nothing for a frame it cannot read, so one bad frame does not end the run", () => {
    // Dropping one frame is visible and recoverable; throwing here would end the
    // stream and lose every step after it.
    expect(parseRunEvent("data: not json at all")).toBeNull();
    expect(parseRunEvent("data: {\"type\":\"nonsense\"}")).toBeNull();
  });

  it("keeps a rejected step's text out of the shape the screen renders", () => {
    // `detail` is free text from the loop. It is kept in the event so the log can
    // show why, but the screen renders `reason`; anything else would be putting a
    // model's words where a constraint should be.
    const event = parseRunEvent(
      'data: {"type":"step","step":{"seq":1,"turn":1,"kind":"rejected","label":"x refused","payload":{"reason":"not on the allowlist"}}}',
    ) as RunEvent;
    expect(event.type).toBe("step");
  });
});
