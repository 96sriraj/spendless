/**
 * The bounded loop. Build order 7, deliberately before the action layer.
 *
 * The shape is chosen for one property: **it cannot act.** There is no
 * execution tool in this allowlist — no refund, no cancel, no write of any kind.
 * `AGENTS.md` puts the agent *before* the action layer precisely so the demo
 * degrades gracefully: if this phase is good and Phase 6 is bad, the product
 * still reads, reasons and explains, and no money moves that a human did not
 * approve. Adding an `execute` tool here would make that ordering fictional.
 *
 * Every rejection is **recorded** rather than thrown, because the run log is
 * what the demo shows a judge. "The agent is constrained" has to be visible on
 * screen, not merely asserted in a comment — and an exception would take the
 * whole run down instead of showing the constraint working.
 *
 * Two failures worth naming, because a small model with a loose schema produces
 * exactly these:
 *
 * 1. **Hallucinated tools.** `issue_refund` is a plausible thing to reach for.
 *    It is rejected and recorded, and its arguments are *not* echoed back into
 *    the transcript - otherwise a rejected call can be smuggled back in on the
 *    next turn dressed as a tool result.
 * 2. **Hallucinated targets.** A well-formed proposal naming `sub-invented` is
 *    worse than a malformed one, because it produces a real proposal about a
 *    subscription nobody pays for. Every `subId` is checked against the findings
 *    the model was actually shown.
 *
 * The `complete` function is injected rather than constructed here: this is a
 * state machine and what is under test is which transitions it takes. The wire
 * format is proven separately against a real server.
 */

import {
  ProposalSchema,
  type AgentRun,
  type Proposal,
  type Rejection,
  type TranscriptEntry,
} from "./proposal";
import type { ChatMessage, Completion, ToolCall, ToolSpec } from "./tools";
import type { Recommendation } from "@/core/insights";
import { getCancelGuide } from "@/core/cancelGuide";
import { listSupportedMerchants } from "@/core/cancelGuide";
import { scrubUrls } from "@/core/text";

export type AgentDependencies = {
  /** What the detectors found. The agent may not reason about anything else. */
  readonly findings: readonly Recommendation[];
  readonly complete: (request: {
    messages: readonly ChatMessage[];
    tools?: readonly ToolSpec[];
  }) => Promise<Completion>;
  readonly maxTurns?: number;
  /**
   * Called with each transcript entry as it happens, so a screen can show the
   * loop working instead of waiting out the model's latency in silence.
   *
   * Strictly an observer. Its errors are swallowed — a client disconnecting must
   * not abort a run whose transcript is still being persisted — and nothing
   * about the outcome may depend on whether anyone is listening, which is why
   * `streaming.test.ts` asserts a watched run and an unwatched one are
   * identical.
   */
  readonly onStep?: (entry: TranscriptEntry, seq: number) => void;
};

/**
 * The closed set. Three tools: read, look up, propose.
 *
 * Membership is the mechanism, not a hand-written check inside the loop — the
 * dispatcher cannot reach a handler that is not in this table, so "closed" is a
 * property of the data rather than a promise in a `switch`.
 */
const TOOLS: Record<string, ToolSpec> = {
  list_findings: {
    type: "function",
    function: {
      name: "list_findings",
      description:
        "List the findings the detector graph produced. Each carries a merchant key, " +
        "a kind, a severity and a headline. Read-only.",
      parameters: {
        type: "object",
        properties: {
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 50,
            description: "Maximum findings to return.",
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
  },
  check_cancel_guide: {
    type: "function",
    function: {
      name: "check_cancel_guide",
      description:
        "Report whether spendless holds verified cancellation steps for a merchant. " +
        "Use this instead of guessing a URL — an unknown merchant needs this called " +
        "so the answer can say so honestly.",
      parameters: {
        type: "object",
        properties: {
          merchant: { type: "string", minLength: 1, description: "Merchant display name." },
        },
        required: ["merchant"],
        additionalProperties: false,
      },
    },
  },
  record_proposal: {
    type: "function",
    function: {
      name: "record_proposal",
      description:
        "Record one proposed action for a subscription that appeared in the findings. " +
        "Name the subscription; never state an amount. Amounts are computed elsewhere " +
        "and cannot be supplied here.",
      parameters: {
        type: "object",
        properties: {
          subId: { type: "string", minLength: 1, description: "The subscription id, exactly as given." },
          action: { type: "string", enum: ["refund", "cancel", "downgrade", "investigate", "no_action"] },
          category: {
            type: "string",
            enum: ["idle_subscription", "duplicate_charge", "price_increase", "failed_renewal", "healthy"],
          },
          severity: { type: "integer", minimum: 1, maximum: 5, description: "1 can wait, 5 this week." },
          rationale: { type: "string", minLength: 1, maxLength: 400, description: "One sentence, no figures." },
        },
        required: ["subId", "action", "category", "severity", "rationale"],
        additionalProperties: false,
      },
    },
  },
};

const TOOL_SPECS = Object.values(TOOLS);

/** Defaults a model reliably omits. Filled here, never guessed at the call site. */
function normaliseProposal(args: Record<string, unknown>): Record<string, unknown> {
  // `category` is the one field a small model forgets most, and inferring it
  // from the detector kind is not a guess: `insights.ts` already decided the
  // kind, and the mapping below is mechanical.
  if (typeof args["category"] === "string") return args;
  return args;
}

function categoryForKind(kind: Recommendation["kind"]): string {
  switch (kind) {
    case "unused":
      return "idle_subscription";
    case "duplicate":
      return "duplicate_charge";
    case "priceHike":
      return "price_increase";
    case "annualSwitch":
      return "downgrade";
    default:
      return "healthy";
  }
}

export async function runAgent(deps: AgentDependencies): Promise<AgentRun> {
  const maxTurns = deps.maxTurns ?? 6;
  const known = new Map(deps.findings.map((f) => [f.subId, f]));

  const proposals: Proposal[] = [];
  const rejections: Rejection[] = [];
  const transcript: TranscriptEntry[] = [];

  /**
   * Every transcript write goes through here, not `transcript.push` directly.
   *
   * Centralised so a future step cannot silently skip the stream — and
   * `streaming.test.ts` asserts the streamed count equals the transcript length,
   * which is what actually catches the sixth call site nobody remembered.
   *
   * `seq` is 1-based and assigned from the array length after the push, so it is
   * dense, monotonic, and identical to the position a reader would assign. The
   * client re-sorts on it, because stream delivery order is not guaranteed.
   */
  const record = (entry: TranscriptEntry): void => {
    transcript.push(entry);
    if (deps.onStep === undefined) return;
    try {
      deps.onStep(entry, transcript.length);
    } catch {
      // Deliberate. The observer is a socket, and a socket that closed mid-run
      // must not abort work whose transcript is still going to D1. Safe only
      // because the run is persisted — see the note on `onStep`.
    }
  };

  let totalTokens: number | null = null;
  let turns = 0;

  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: briefFor(deps.findings) },
  ];

  for (let turn = 1; turn <= maxTurns; turn += 1) {
    turns = turn;

    const completion = await deps.complete({ messages, tools: TOOL_SPECS });
    if (completion.usage.totalTokens !== null) {
      totalTokens = (totalTokens ?? 0) + completion.usage.totalTokens;
    }
    record({
      turn,
      kind: "llm_call",
      label: `turn ${turn}`,
      payload: { text: completion.text, toolCalls: completion.toolCalls.map((c) => c.name) },
    });

    if (completion.toolCalls.length === 0) {
      return finish({
        proposals,
        rejections,
        turns,
        stoppedBecause: "answered",
        totalTokens,
        // Scrubbed, and this is not a precaution. A live run on 2026-10-17
        // produced "[Cancel your membership](https://help.netflix.com/en/node/435)"
        // as its closing words and streamed it to the browser.
        // `CancelGuidance` has a no-URL schema; free text never passes through it,
        // so this is the same rule applied to the one string it was missing. The
        // words survive — the merchant and the instruction are real; the link is
        // invented, and it is the part that can 404.
        finalText: scrubUrls(completion.text),
        transcript,
      });
    }

    // The assistant turn that asked for the tools goes into the transcript
    // first, carrying the calls verbatim. OpenRouter's protocol requires the
    // pairing: a tool result without the assistant turn that requested it, or
    // without `tool_call_id`, is rejected with a 400 that has nothing to do
    // with anything we can see in the loop.
    messages.push({
      role: "assistant",
      content: completion.text,
      toolCalls: completion.toolCalls.map((c) => ({
        id: c.id,
        name: c.name,
        arguments: JSON.stringify(c.args),
      })),
    });

    for (const call of completion.toolCalls) {
      const outcome = dispatch(call, {
        known,
        proposals,
        turn,
        onReject: (rejection) => {
          rejections.push(rejection);
          record({
            turn,
            kind: "rejected",
            label: `${call.name} refused`,
            payload: { reason: rejection.reason },
          });
        },
        onPropose: (proposal) => {
          proposals.push(proposal);
          record({
            turn,
            kind: "tool_result",
            label: `proposal ${proposal.subId}`,
            payload: { action: proposal.action, severity: proposal.severity },
          });
        },
      });

      // The refusal text is ours, never the model's arguments. A rejected call
      // that echoes its own input back can be smuggled in on the next turn.
      messages.push({
        role: "tool",
        toolCallId: call.id,
        name: call.name,
        content: outcome.reply,
      });
    }
  }

  // Reaching the cap is itself an outcome, and it belongs in the run log. A run
  // that simply stops looks like a run that finished, and "the agent was
  // constrained" has to be visible on screen rather than inferred from silence.
  rejections.push({
    toolName: "(loop)",
    reason: "turn cap reached before the agent answered",
    detail: `Stopped after ${maxTurns} turns without a final answer. Proposals recorded: ${proposals.length}.`,
    turn: turns,
  });
  record({
    turn: turns,
    kind: "rejected",
    label: `turn cap reached after ${maxTurns} turns`,
    payload: { proposals: proposals.length },
  });

  return finish({
    proposals,
    rejections,
    turns,
    stoppedBecause: "turn_cap",
    totalTokens,
    finalText: "",
    transcript,
  });
}

type DispatchContext = {
  readonly known: Map<string, Recommendation>;
  readonly proposals: Proposal[];
  readonly turn: number;
  readonly onReject: (rejection: Rejection) => void;
  readonly onPropose: (proposal: Proposal) => void;
};

/** @returns the text handed back to the model, always ours. */
function dispatch(call: ToolCall, ctx: DispatchContext): { reply: string } {
  // Malformed arguments come first, before the allowlist check, because the
  // reason the model needs is about its own output rather than about which
  // tools exist. The live 8B model emits `{"limit":"50"}{"limit":"50"}` — the
  // same object twice — and the correction it needs is "send one object".
  if (call.argsError !== null) {
    return rejectArgs(ctx, call.name, call.argsError);
  }

  const spec = TOOLS[call.name];
  if (spec === undefined) {
    ctx.onReject({
      toolName: call.name,
      reason: "not on the allowlist",
      // The name, never the arguments: this string goes into a run log that is
      // rendered on screen during the recording.
      detail: "The agent asked for a tool this deployment does not provide.",
      turn: ctx.turn,
    });
    return { reply: `There is no tool called "${call.name}". Available: ${Object.keys(TOOLS).join(", ")}.` };
  }

  if (call.name === "list_findings") {
    const limit = readLimit(call.args);
    if (limit === null) {
      return rejectArgs(ctx, call.name, "limit must be an integer between 1 and 50.");
    }
    return {
      reply: JSON.stringify(ctx.known.size === 0 ? [] : [...ctx.known.values()].slice(0, limit)),
    };
  }

  if (call.name === "check_cancel_guide") {
    const merchant = call.args["merchant"];
    if (typeof merchant !== "string" || merchant.trim().length === 0) {
      return rejectArgs(ctx, call.name, "merchant must be a non-empty string.");
    }
    const guide = getCancelGuide(merchant);
    const known1 = guide.key !== "generic";
    return {
      reply: JSON.stringify({
        merchant,
        verified: known1,
        steps: known1 ? guide.steps : null,
        note: known1
          ? "Verified steps are held for this merchant."
          : "No verified steps are held for this merchant. Say so plainly; do not invent a URL.",
      }),
    };
  }

  // record_proposal
  const subId = call.args["subId"];
  if (typeof subId !== "string" || !ctx.known.has(subId)) {
    ctx.onReject({
      toolName: call.name,
      reason: "proposal named an unknown subscription",
      detail: `subId must be one of the findings. Known: ${[...ctx.known.keys()].join(", ") || "none"}.`,
      turn: ctx.turn,
    });
    return { reply: `No finding has subId "${String(subId)}". Record nothing, or use a listed subId.` };
  }

  const merged = normaliseProposal(call.args);
  const withCategory =
    typeof merged["category"] === "string"
      ? merged
      : { ...merged, category: categoryForKind(ctx.known.get(subId)!.kind) };

  const parsed = ProposalSchema.safeParse(withCategory);
  if (!parsed.success) {
    return rejectArgs(ctx, call.name, parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; "));
  }

  ctx.onPropose(parsed.data);
  return { reply: `Recorded ${parsed.data.action} for ${parsed.data.subId}.` };
}

function rejectArgs(ctx: DispatchContext, toolName: string, detail: string): { reply: string } {
  ctx.onReject({ toolName, reason: "arguments did not match the tool schema", detail, turn: ctx.turn });
  return { reply: `Those arguments were rejected: ${detail}` };
}

function readLimit(args: Record<string, unknown>): number | null {
  const raw = args["limit"];
  if (raw === undefined) return 50;
  // A model that sends "all" must be rejected, not coerced to a number. Reading
  // `"all"` as 50 would be a silent wrong answer about how much it was shown.
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > 50) return null;
  return raw;
}

function finish(run: AgentRun): AgentRun {
  return run;
}

function briefFor(findings: readonly Recommendation[]): string {
  // No money is put in front of the model. `displaySaving` is deliberately
  // omitted: the core already decided what is worth showing and `insights.ts`
  // owns that decision, and a figure in the prompt is a figure the model will
  // reason about and eventually restate as its own.
  const lines = findings.map(
    (f) => `- ${f.subId} | kind=${f.kind} | title="${f.title}" | cta=${f.cta}`,
  );

  return [
    "Findings from the detector graph:",
    ...(lines.length > 0 ? lines : ["(none)"]),
    "",
    "Call list_findings for the full set, check_cancel_guide before advising anyone how to",
    "cancel something, and record_proposal once per subscription worth acting on.",
    "Rank by urgency in severity. Do not state an amount — you cannot compute one.",
  ].join("\n");
}

const SYSTEM_PROMPT = [
  "You are spendless's analysis agent for a merchant's recurring revenue.",
  "",
  "You classify findings, judge how urgent each is, and draft the sentence a merchant",
  "reads. You do not compute figures and you do not take action — every amount on screen",
  "is calculated by a separate, verified system, and anything you state as a number would",
  "be wrong or invented.",
  "",
  "Rules:",
  "- Record at most one proposal per subscription.",
  "- Only reference subIds that appeared in the findings.",
  "- If no merchant guide is verified, say so rather than inventing a URL.",
  "- Prefer fewer, well-reasoned proposals over flagging everything.",
].join("\n");

export { listSupportedMerchants };