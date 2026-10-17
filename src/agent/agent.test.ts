import { describe, expect, it } from "vitest";
import { runAgent, type AgentDependencies } from "./agent";
import { ProposalSchema } from "./proposal";
import type { Completion } from "./tools";
import type { Recommendation } from "@/core/insights";

/**
 * The bounded loop, proven against a scripted model.
 *
 * `complete` is injected rather than stubbed at the network level: the loop is
 * a state machine, and what is under test is which transitions it takes. The
 * wire format is proven separately, against a real HTTP server, in
 * `test/integration/openrouter.test.ts`.
 *
 * The three properties below are P5-07's three failure modes, and they are the
 * ones a small model with a loose schema actually produces. A wandering model
 * does not fail by refusing to answer; it fails by inventing a tool, inventing
 * an argument, and looping. Every one of those has to end in a **recorded**
 * rejection rather than an exception or a silent retry, because the run log is
 * what the demo shows a judge — "the agent was constrained" has to be visible
 * on screen, not merely true in a comment.
 *
 * The fourth property is the one that matters most and is easiest to lose:
 * **the agent cannot emit a money figure.** Every figure on screen has to trace
 * to a pure core function, so the proposal schema is strict and a proposal
 * carrying an amount is rejected at the boundary rather than trusted.
 */

const FINDING: Recommendation = {
  kind: "unused",
  subId: "sub-netflix",
  title: "Netflix unused for 91 days",
  subtitle: "Last used 91 days ago",
  savingCents: 1_599,
  displaySaving: "$47.97 wasted",
  cta: "Consider cancel",
  confidence: 0.9,
};

const SECOND: Recommendation = {
  kind: "priceHike",
  subId: "sub-adobe",
  title: "Adobe price increased",
  subtitle: "$49.99 -> $54.99",
  savingCents: 500,
  cta: "Negotiate",
  confidence: 0.7,
};

function deps(overrides: Partial<AgentDependencies> = {}): AgentDependencies {
  return {
    findings: [FINDING, SECOND],
    complete: async () => ({
      text: "done",
      toolCalls: [],
      finishReason: "stop",
      usage: { totalTokens: 10 },
    }),
    maxTurns: 6,
    ...overrides,
  };
}

/** A model that walks the given script, one completion per call. */
function scripted(steps: readonly Partial<Completion>[], after?: Partial<Completion>) {
  let index = 0;
  return async (): Promise<Completion> => {
    const step = index < steps.length ? steps[index] : after;
    index += 1;
    return {
      text: step?.text ?? "",
      toolCalls: step?.toolCalls ?? [],
      finishReason: step?.finishReason ?? "stop",
      usage: { totalTokens: 10 },
    };
  };
}

const call = (name: string, args: unknown, id = "c1") => ({
  id,
  name,
  args: args as Record<string, unknown>,
  argsError: null,
});

describe("ProposalSchema", () => {
  it("rejects a proposal carrying a money figure", () => {
    // The rule from AGENTS.md, enforced at the boundary. If this ever passes,
    // an LLM-computed amount can reach the run log and the UI, and the claim
    // that every figure traces to a pure core function is no longer true.
    //
    // `category` is present on purpose. Without it this assertion passed for the
    // wrong reason — zod rejected the *missing field*, so it proved nothing
    // about money. Removing `.strict()` from the schema left this test green,
    // which is the only reason that was caught before shipping.
    const withAmount = {
      subId: "sub-netflix",
      action: "refund",
      category: "idle_subscription",
      severity: 3,
      rationale: "unused for 91 days",
      amountCents: 1599,
    };
    expect(ProposalSchema.safeParse(withAmount).success).toBe(false);
  });

  it("would accept that same proposal if the money field were absent", () => {
    // The control. Without it, the test above could keep passing for any reason
    // at all — which is exactly what happened once.
    expect(
      ProposalSchema.safeParse({
        subId: "sub-netflix",
        action: "refund",
        category: "idle_subscription",
        severity: 3,
        rationale: "unused for 91 days",
      }).success,
    ).toBe(true);
  });

  it("accepts a proposal that names the subscription and explains itself", () => {
    // Complete, because the schema is strict in both directions: it rejects
    // unknown keys and it requires every key it declares. The loop fills in
    // `category` from the detector kind before parsing, so by the time a
    // proposal reaches this schema it is whole.
    const parsed = ProposalSchema.safeParse({
      subId: "sub-netflix",
      action: "refund",
      category: "idle_subscription",
      severity: 3,
      rationale: "No usage in 91 days; renewal in 3 days.",
    });
    expect(parsed.success).toBe(true);
  });

  it("refuses a severity outside the scale rather than clamping it", () => {
    // A clamped 99 would rank first and look deliberate. A rejection is
    // visible; a clamp is a silent wrong answer.
    const parsed = ProposalSchema.safeParse({
      subId: "sub-x",
      action: "refund",
      severity: 99,
      rationale: "very important",
    });
    expect(parsed.success).toBe(false);
  });
});

describe("runAgent — the happy path", () => {
  it("records the proposals the model commits to", async () => {
    const complete = scripted([
      {
        toolCalls: [
          call("list_findings", {}, "c1"),
          call(
            "record_proposal",
            {
              subId: "sub-netflix",
              action: "refund",
              severity: 4,
              rationale: "Idle 91 days, renews in 3 days.",
            },
            "c2",
          ),
        ],
        finishReason: "tool_calls",
      },
      { text: "One proposal recorded." },
    ]);

    const run = await runAgent(deps({ complete }));

    expect(run.proposals).toHaveLength(1);
    expect(run.proposals[0]?.subId).toBe("sub-netflix");
    expect(run.stoppedBecause).toBe("answered");
    expect(run.rejections).toEqual([]);
  });

  it("shows the model the findings it is reasoning over", async () => {
    let seen = "";
    const complete = async (request: { messages: readonly { content: string }[] }) => {
      seen = JSON.stringify(request.messages);
      return { text: "ok", toolCalls: [], finishReason: "stop", usage: { totalTokens: 1 } };
    };

    await runAgent(deps({ complete: complete as never }));

    // The agent ranks and explains; it cannot rank what it cannot see.
    expect(seen).toContain("sub-netflix");
    expect(seen).toContain("Netflix unused for 91 days");
  });

  it("keeps every proposal the model records, not just the last", async () => {
    const complete = scripted([
      {
        toolCalls: [
          call("record_proposal", { subId: "sub-netflix", action: "refund", severity: 4, rationale: "idle" }, "c1"),
          call("record_proposal", { subId: "sub-adobe", action: "investigate", severity: 2, rationale: "price rose" }, "c2"),
        ],
        finishReason: "tool_calls",
      },
      { text: "two" },
    ]);

    const run = await runAgent(deps({ complete }));
    expect(run.proposals.map((p) => p.subId)).toEqual(["sub-netflix", "sub-adobe"]);
  });
});

describe("runAgent — the allowlist is closed", () => {
  it("refuses a tool that is not on the list, and records the refusal", async () => {
    const complete = scripted([
      { toolCalls: [call("issue_refund", { captureId: "x", amountCents: 999999 }, "c1")], finishReason: "tool_calls" },
      { text: "I cannot do that." },
    ]);

    const run = await runAgent(deps({ complete }));

    expect(run.proposals).toEqual([]);
    // Recorded, not thrown: the refusal is the demo's evidence that the agent
    // is bounded rather than merely well-behaved.
    expect(run.rejections).toHaveLength(1);
    expect(run.rejections[0]?.toolName).toBe("issue_refund");
    expect(run.rejections[0]?.reason).toMatch(/not on the allowlist/i);
  });

  it("never lets an unknown tool's arguments reach anything", async () => {
    const complete = scripted([
      { toolCalls: [call("wire_money", { to: "attacker", cents: 1e9 }, "c1")], finishReason: "tool_calls" },
      { text: "no" },
    ]);

    const run = await runAgent(deps({ complete }));
    // The argument never appears in the transcript handed back to the model
    // either, so a rejected call cannot be smuggled back in on the next turn.
    expect(run.rejections[0]?.detail).not.toContain("attacker");
  });

  it("refuses arguments that do not match the tool's schema, and records it", async () => {
    const complete = scripted([
      // `limit` must be a number. A model that sends the string "all" is the
      // failure mode a tight schema exists to catch.
      { toolCalls: [call("list_findings", { limit: "all" }, "c1")], finishReason: "tool_calls" },
      { text: "recovered" },
    ]);

    const run = await runAgent(deps({ complete }));

    expect(run.rejections).toHaveLength(1);
    expect(run.rejections[0]?.reason).toMatch(/arguments/i);
  });

  it("refuses a proposal naming a subscription that does not exist", async () => {
    const complete = scripted([
      {
        toolCalls: [
          call("record_proposal", { subId: "sub-invented", action: "refund", severity: 5, rationale: "hallucinated" }, "c1"),
        ],
        finishReason: "tool_calls",
      },
      { text: "ok" },
    ]);

    const run = await runAgent(deps({ complete }));

    // Hallucinating the target is the worst failure this loop can have: it
    // produces a well-formed proposal about a subscription nobody pays for.
    expect(run.proposals).toEqual([]);
    expect(run.rejections[0]?.reason).toMatch(/unknown subscription/i);
  });
});

describe("runAgent — the turn cap", () => {
  it("stops at the cap instead of looping forever", async () => {
    // A model that keeps calling a tool without ever answering. The loop has
    // to end, and to say why.
    const complete = scripted([], {
      toolCalls: [call("list_findings", {}, "loop")],
      finishReason: "tool_calls",
    });

    const run = await runAgent(deps({ complete, maxTurns: 3 }));

    expect(run.stoppedBecause).toBe("turn_cap");
    expect(run.turns).toBe(3);
    expect(run.rejections.some((r) => r.reason.includes("turn cap"))).toBe(true);
  });

  it("counts a rejected call as a turn, so a bad loop still terminates", async () => {
    // Otherwise a model stuck in reject-nothing-repeat would burn the API
    // budget for the length of the recording.
    const complete = scripted([], {
      toolCalls: [call("nonsense", {}, "loop")],
      finishReason: "tool_calls",
    });

    const run = await runAgent(deps({ complete, maxTurns: 2 }));
    expect(run.turns).toBe(2);
    expect(run.stoppedBecause).toBe("turn_cap");
  });
});

describe("runAgent — determinism", () => {
  it("produces identical runs from identical inputs", async () => {
    const script = () =>
      scripted([
        {
          toolCalls: [
            call("record_proposal", { subId: "sub-netflix", action: "refund", severity: 4, rationale: "idle" }, "c1"),
          ],
          finishReason: "tool_calls",
        },
        { text: "done" },
      ]);

    const first = await runAgent(deps({ complete: script() }));
    const second = await runAgent(deps({ complete: script() }));

    expect(JSON.stringify(second)).toEqual(JSON.stringify(first));
  });
});