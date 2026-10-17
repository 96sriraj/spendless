import { describe, expect, it } from "vitest";
import { resolveCancelGuide, GUIDANCE_TOOL_NAME } from "./cancelResolution";
import type { ChatMessage, Completion } from "./tools";

/**
 * P5-04. The one-sentence answer to "where exactly is the AI here?"
 *
 * Nixt's resolver had a fallback: when it did not know a merchant, it built a
 * Google search URL and three generic steps. That is the weakest branch of an
 * existing function, and it is the branch this agent replaces.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE AGENT MUST NOT DO: invent a URL.
 * ---------------------------------------------------------------------------
 *
 * The tempting output is "go to https://<merchant>.com/billing and cancel". A
 * model will produce that confidently, and roughly half of those hosts do not
 * exist, route somewhere else, or belong to somebody else. A cancellation link
 * that 404s is worse than no link: the user trusts it, it fails at the worst
 * moment, and it makes the whole product look careless.
 *
 * So the guidance schema **has no `url` field at all** — not "url is optional",
 * not "url is validated". There is nowhere for one to go. `.strict()` on top
 * means a model that volunteers `https://...` anyway is rejected rather than
 * silently kept.
 *
 * What it gets instead is *specific* guidance: which settings page to open, what
 * to look for, what the confirmation looks like. That is genuinely more useful
 * than the search link and cannot be a dead end.
 *
 * This lives above `src/core`, not inside it. `cancelGuide.ts` stays pure — the
 * core imports nothing from any layer above it — so the agent branch is a
 * wrapper the call sites use, not a patch on a pure function.
 */

const GUIDANCE_TOOL = GUIDANCE_TOOL_NAME;

/** A model that answers with one tool call carrying the given arguments. */
function answering(args: Record<string, unknown>): (request: { messages: readonly ChatMessage[] }) => Promise<Completion> {
  return async () => ({
    text: "",
    toolCalls: [{ id: "g1", name: GUIDANCE_TOOL, args }],
    finishReason: "tool_calls",
    usage: { totalTokens: 20 },
  });
}

const GOOD = {
  merchant: "Headspace",
  whereToLook: "Settings → Account → Subscription",
  steps: [
    "Open Settings in the Headspace app or on the website.",
    "Choose Account, then Subscription to see the current plan.",
    "Select Cancel subscription and confirm when prompted.",
  ],
};

describe("resolveCancelGuide — a merchant we already know", () => {
  it("returns the verified guide without asking the model anything", async () => {
    let asked = false;
    const result = await resolveCancelGuide("Netflix", {
      complete: async () => {
        asked = true;
        return { text: "", toolCalls: [], finishReason: "stop", usage: { totalTokens: 1 } };
      },
    });

    expect(asked).toBe(false);
    expect(result.verified).toBe(true);
    expect(result.guide?.steps.length ?? 0).toBeGreaterThan(0);
  });

  it("resolves a variant name to the same verified guide", async () => {
    // "My Netflix Family" must not fall through to the agent branch - we know
    // the merchant, and an LLM rewrite of a known answer is strictly worse.
    const result = await resolveCancelGuide("My Netflix Family", {
      complete: async () => {
        throw new Error("should not have been called");
      },
    });
    expect(result.verified).toBe(true);
  });
});

describe("resolveCancelGuide — a merchant we do not know", () => {
  it("uses the agent's specific steps", async () => {
    const result = await resolveCancelGuide("Headspace", { complete: answering(GOOD) });

    expect(result.verified).toBe(false);
    expect(result.steps).toEqual(GOOD.steps);
    expect(result.whereToLook).toBe("Settings → Account → Subscription");
  });

  it("never carries a URL, because the model will invent one", async () => {
    // The dangerous output. If this ever renders, a user follows a link to a
    // host the model made up and the product has failed at its one job.
    const result = await resolveCancelGuide("Headspace", {
      complete: answering({ ...GOOD, url: "https://headspace.com/billing/cancel" }),
    });

    expect(JSON.stringify(result)).not.toMatch(/https?:\/\//);
  });

  it("rejects a URL buried inside a step, which a schema cannot strip away", async () => {
    // The version that actually bites. A top-level `url` field is discarded
    // harmlessly, but "Open Settings at https://headspace.com/billing" passes
    // straight through — and that is the shape a model produces most often,
    // because it puts the link in the sentence rather than in a field.
    //
    // So the rule is not "no url key", it is "no URL anywhere in the answer".
    const result = await resolveCancelGuide("Headspace", {
      complete: answering({
        ...GOOD,
        steps: [
          "Open the app and go to Settings → Account.",
          "Open https://headspace.com/billing to continue.",
          "Select Cancel subscription.",
        ],
      }),
    });

    expect(JSON.stringify(result)).not.toMatch(/https?:\/\//);
    // And it falls back rather than keeping the good steps around the bad one.
    expect(result.whereToLook).toBeNull();
  });

  it("keeps the usable steps when the model adds a harmless extra field", async () => {
    // Why this schema is NOT `.strict()`. A small model routinely volunteers a
    // `confidence` or `notes` field. Rejecting the whole answer for that costs
    // the merchant real guidance over a stray key, and the thing we actually
    // care about — a URL — is prevented by the checks above either way.
    const result = await resolveCancelGuide("Headspace", {
      complete: answering({ ...GOOD, confidence: "high", notes: "checked twice" }),
    });

    expect(result.steps).toEqual(GOOD.steps);
    expect(result.whereToLook).toBe("Settings → Account → Subscription");
  });

  it("says plainly that the steps are unverified", async () => {
    // A confident answer reads as a verified one. The demo's honesty rule is
    // "never present invented data as observed data", and guidance from a model
    // is invented data.
    const result = await resolveCancelGuide("Headspace", { complete: answering(GOOD) });
    expect(result.verified).toBe(false);
    expect(result.assurance).toMatch(/unverified|not confirmed|may have changed/i);
  });

  it("falls back to an honest answer rather than throwing when the model returns junk", async () => {
    // A demo must not die because a 1B model produced one malformed tool call.
    // Degrading is the whole design of build order 7.
    const result = await resolveCancelGuide("Headspace", {
      complete: answering({ merchant: "Headspace", steps: ["only one"] }),
    });

    expect(result.verified).toBe(false);
    expect(result.steps.length).toBeGreaterThan(0);
  });

  it("degrades rather than hanging when the model calls no tool at all", async () => {
    const result = await resolveCancelGuide("Headspace", {
      complete: async () => ({
        text: "I would look in your account settings.",
        toolCalls: [],
        finishReason: "stop",
        usage: { totalTokens: 5 },
      }),
    });

    expect(result.verified).toBe(false);
    expect(result.steps.length).toBeGreaterThan(0);
  });
});