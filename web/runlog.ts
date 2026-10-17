/**
 * The run log's state machine.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS PURE AND SEPARATE FROM THE COMPONENT
 * ---------------------------------------------------------------------------
 *
 * The component that renders the log is a `map`. Every decision worth testing is
 * upstream of it, and all of those decisions are pure, so they live here where a
 * test can reach them without a DOM, an `EventSource`, or a Worker — which is the
 * same argument that produced `hero.ts`.
 *
 * ---------------------------------------------------------------------------
 * THE PROPERTY THIS FILE EXISTS FOR
 * ---------------------------------------------------------------------------
 *
 * **Out-of-order delivery must still render in order.** `EventSource` gives no
 * ordering guarantee, and a reconnect replays from the last id it saw. A log that
 * renders arrival order puts "proposal sub-netflix" above the call that produced
 * it, which reads as though the agent conjured a proposal from nothing — the exact
 * suspicion this screen exists to dispel.
 *
 * So `seq` is the sort key and not the arrival index, and a replay is idempotent.
 * Both are asserted in `runlog.test.ts`, and both are the kind of thing that only
 * fails on a bad network, which is to say during the recording.
 */

export type RunStepKind = "llm_call" | "tool_call" | "tool_result" | "rejected";

export type RunStep = {
  readonly seq: number;
  readonly turn: number;
  readonly kind: RunStepKind;
  readonly label: string;
  readonly payload?: unknown;
};

export type RunProposal = {
  readonly subId: string;
  readonly action: "refund" | "cancel" | "downgrade" | "investigate" | "no_action";
  readonly category: string;
  readonly severity: number;
  readonly rationale: string;
};

export type RunRejection = {
  readonly toolName: string;
  readonly reason: string;
  readonly detail: string;
  readonly turn: number;
};

export type RunEvent =
  | { readonly type: "step"; readonly step: RunStep }
  | {
      readonly type: "done";
      readonly proposals: readonly RunProposal[];
      readonly rejections: readonly RunRejection[];
      readonly turns: number;
      readonly stoppedBecause: "answered" | "turn_cap";
      readonly finalText: string;
    }
  | { readonly type: "error"; readonly message: string };

export type RunPhase = "idle" | "running" | "done" | "error";

export type RunState = {
  readonly phase: RunPhase;
  readonly steps: readonly RunStep[];
  readonly proposals: readonly RunProposal[];
  readonly rejections: readonly RunRejection[];
  readonly turns: number;
  readonly stoppedBecause: "answered" | "turn_cap" | null;
  readonly finalText: string;
  readonly error: string | null;
};

export function emptyRunState(): RunState {
  return {
    phase: "idle",
    steps: [],
    proposals: [],
    rejections: [],
    turns: 0,
    stoppedBecause: null,
    finalText: "",
    error: null,
  };
}

export function applyRunEvent(state: RunState, event: RunEvent): RunState {
  // A reconnect can deliver one last frame after the terminal event. Letting it
  // through flips the screen back to "running" on a finished run, which reads as
  // a stuck button.
  if (state.phase === "done" || state.phase === "error") return state;

  if (event.type === "step") {
    const incoming = event.step;
    if (state.steps.some((s) => s.seq === incoming.seq)) return state;

    return {
      ...state,
      phase: "running",
      // Sorted on `seq` rather than appended, and sorted on every insert rather
      // than once at the end: the log is read while it streams, so a late-arriving
      // low `seq` has to land in the right place immediately.
      steps: [...state.steps, incoming].sort((a, b) => a.seq - b.seq),
    };
  }

  if (event.type === "done") {
    return {
      ...state,
      phase: "done",
      proposals: event.proposals,
      rejections: event.rejections,
      turns: event.turns,
      stoppedBecause: event.stoppedBecause,
      finalText: event.finalText,
    };
  }

  // The steps stay. "It failed" with a visible partial log is a far better demo
  // than a clean screen that hides the failure — and it is the difference between
  // an agent that is inspectable and one that just stops.
  return { ...state, phase: "error", error: event.message };
}

const STEP_KINDS: readonly RunStepKind[] = [
  "llm_call",
  "tool_call",
  "tool_result",
  "rejected",
];

/**
 * Read one SSE data frame.
 *
 * Returns `null` for anything it cannot use — keep-alive comments, a malformed
 * frame, an unknown event type — rather than throwing.
 *
 * Dropping one frame is visible and recoverable. Throwing would end the stream
 * and lose every step after it, and this parse runs on whatever the network
 * happened to deliver.
 */
export function parseRunEvent(frame: string): RunEvent | null {
  const trimmed = frame.trim();
  // `: ping` keep-alives, and the empty data of a comment frame.
  if (trimmed.length === 0 || trimmed.startsWith(":")) return null;
  if (!trimmed.startsWith("data:")) return null;

  const body = trimmed.slice("data:".length).trim();
  if (body.length === 0) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) return null;
  const event = parsed as Record<string, unknown>;

  if (event["type"] === "error") {
    return typeof event["message"] === "string"
      ? { type: "error", message: event["message"] }
      : null;
  }

  if (event["type"] === "done") {
    const read = parseDone(event);
    return read;
  }

  if (event["type"] !== "step") return null;

  const step = event["step"];
  if (typeof step !== "object" || step === null) return null;
  const s = step as Record<string, unknown>;

  if (typeof s["seq"] !== "number" || !Number.isFinite(s["seq"])) return null;
  if (typeof s["label"] !== "string") return null;
  if (!STEP_KINDS.includes(s["kind"] as RunStepKind)) return null;

  return {
    type: "step",
    step: {
      seq: s["seq"],
      turn: typeof s["turn"] === "number" ? s["turn"] : 0,
      kind: s["kind"] as RunStepKind,
      label: s["label"],
      ...(s["payload"] === undefined ? {} : { payload: s["payload"] }),
    },
  };
}

/**
 * Read the terminal frame.
 *
 * The one field that must be present is `stoppedBecause`: it is the whole
 * difference between "the agent answered" and "the agent ran out of turns", and
 * without it there is no conclusion to show. A `done` frame missing it is dropped
 * rather than rendered — showing a half-read terminal frame is how a run appears
 * to have finished having finished nothing.
 *
 * Deliberately tolerant about everything else. `proposals` and `rejections` default
 * to empty, because "the agent proposed nothing" is a perfectly good outcome and a
 * strict parser would drop the frame over it.
 */
function parseDone(event: Record<string, unknown>): RunEvent | null {
  const stoppedBecause = event["stoppedBecause"];
  if (stoppedBecause !== "answered" && stoppedBecause !== "turn_cap") return null;

  return {
    type: "done",
    proposals: readArray(event["proposals"], isProposal),
    rejections: readArray(event["rejections"], isRejection),
    turns: typeof event["turns"] === "number" ? event["turns"] : 0,
    stoppedBecause,
    finalText: typeof event["finalText"] === "string" ? event["finalText"] : "",
  };
}

function readArray<T>(value: unknown, guard: (item: unknown) => item is T): T[] {
  if (!Array.isArray(value)) return [];
  return value.filter(guard);
}

function isProposal(item: unknown): item is RunProposal {
  if (typeof item !== "object" || item === null) return false;
  const p = item as Record<string, unknown>;
  return typeof p["subId"] === "string" && typeof p["rationale"] === "string";
}

function isRejection(item: unknown): item is RunRejection {
  if (typeof item !== "object" || item === null) return false;
  const r = item as Record<string, unknown>;
  return typeof r["reason"] === "string";
}

/**
 * Render a payload for the log line. Nothing here interprets it.
 *
 * Lives beside the reducer rather than in the component for the same reason
 * `hero.ts` exists: this decides what a person reads, and it is pure.
 */
export function describeStep(step: RunStep): string {
  if (step.kind === "llm_call") {
    const payload = step.payload as { toolCalls?: readonly string[] } | undefined;
    const tools = payload?.toolCalls ?? [];
    // Naming the tools is the demo's whole argument: the agent is working inside a
    // closed set, and the screen is where that becomes visible.
    return tools.length > 0 ? `asked for ${tools.join(", ")}` : "answered";
  }
  if (step.kind === "rejected") {
    const payload = step.payload as { reason?: string } | undefined;
    return payload?.reason ?? step.label;
  }
  return step.label;
}

/**
 * One line describing where the run is.
 *
 * Says what is true in each phase rather than showing a spinner, because the whole
 * point of streaming is that the screen is never mysterious.
 */
export function statusLine(state: RunState): string {
  if (state.phase === "idle") return "Not run yet";

  if (state.phase === "running") {
    const n = state.steps.length;
    return `${n} step${n === 1 ? "" : "s"} so far`;
  }

  if (state.phase === "error") return "Stopped early";

  // The turn cap is a constraint being visible, not an ordinary finish. Collapsing
  // it into "6 turns" would make a constrained agent look like one that chose to
  // stop, which is precisely the impression this screen exists to prevent.
  if (state.stoppedBecause === "turn_cap") {
    return `Stopped at the turn cap after ${state.turns} turns`;
  }

  const parts = [
    `${state.turns} turn${state.turns === 1 ? "" : "s"}`,
    `${state.proposals.length} proposal${state.proposals.length === 1 ? "" : "s"}`,
  ];

  // Refusals are the evidence the agent is constrained, so they are counted. But
  // only when there are any: "0 refused" reads as an apology for a clean run.
  if (state.rejections.length > 0) {
    parts.push(`${state.rejections.length} refused`);
  }

  return parts.join(", ");
}