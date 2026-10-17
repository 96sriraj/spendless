/**
 * The agent branch of the cancel-guide resolver. P5-04.
 *
 * This is the seam `ARCHITECTURE.md` §6 points at when it says the answer to
 * "where exactly is the AI here?" is that the agent replaces the weakest branch
 * of an existing resolver. `genericGuide` was that branch: unknown merchant →
 * a Google search URL and three generic steps. Nixt could not execute a
 * cancellation, so it shipped a link and called it guidance.
 *
 * ---------------------------------------------------------------------------
 * WHY NO URL EVER REACHES THE OUTPUT
 * ---------------------------------------------------------------------------
 *
 * Ask a model how to cancel a subscription and it will confidently answer with
 * a URL. Some of them are real. A cancellation link that 404s is worse than no
 * link at all — the user trusts it, it fails at the worst possible moment, and
 * the product looks careless in exactly the place it promised to be careful.
 *
 * Two layers, because one is not enough. The schema has no `url` property, so a
 * top-level link is stripped; and every step is checked for a URL *inside the
 * string*, which is where a model actually puts one. The first is a schema
 * concern. The second is not — no amount of key strictness reaches inside a
 * sentence — and it is the one that matters.
 *
 * What the agent *does* give is more useful than a search link and cannot be a
 * dead end: which settings screen to open, what to look for, what the
 * confirmation looks like.
 *
 * It lives above `src/core` on purpose. `cancelGuide.ts` is pure and stays pure —
 * the core imports nothing from any layer above it — so this wraps the resolver
 * rather than patching it.
 */

import { z } from "zod";
import { getCancelGuide, type CancelGuide } from "@/core/cancelGuide";
import type { ChatMessage, Completion, ToolSpec } from "./tools";

/**
 * The agent's answer. `.strict()`, and deliberately without a `url`.
 */
/**
 * A URL anywhere in the answer, including inside a step.
 *
 * This is the check that matters, and it is not a schema concern: a top-level
 * `url` field can be discarded, but "Open Settings at https://…" cannot. A
 * model asked for a path will put a link in the sentence more often than in a
 * field, because that is how answers are written.
 */
const URL_LIKE = /https?:\/\/|www\./i;

const StepSchema = z
  .string()
  .min(8)
  .max(300)
  .refine((s) => !URL_LIKE.test(s), {
    message: "a step must not contain a URL; describe the settings path instead",
  });

/**
 * Deliberately **not** `.strict()`.
 *
 * A strict object rejects the entire answer if the model volunteers any extra
 * key, and a 1B model volunteers extra keys constantly — `confidence`,
 * `notes`. Rejecting the whole answer for a stray `notes` costs the merchant
 * their guidance over something harmless. Unknown keys are stripped instead,
 * which drops a top-level `url` just as effectively while keeping the steps.
 *
 * The thing we actually cannot tolerate — a URL inside a step — is prevented by
 * `StepSchema` rather than by key strictness, because no amount of key strictness
 * reaches inside a string.
 */
const GuidanceSchema = z.object({
  merchant: z.string().min(1),
  whereToLook: z
    .string()
    .min(1)
    .max(200)
    .refine((s) => !URL_LIKE.test(s), {
      message: "whereToLook must be a settings path, not a URL",
    }),
  steps: z.array(StepSchema).min(2).max(8),
});

export type CancelGuidance = {
  readonly merchant: string;
  /** True only when spendless holds steps it wrote down. Never true for model output. */
  readonly verified: boolean;
  readonly steps: readonly string[];
  readonly whereToLook: string | null;
  /** Always says the steps are not confirmed. Present so the UI cannot omit it. */
  readonly assurance: string;
  /** Set when the agent branch ran and what it produced. */
  readonly guide: CancelGuide | null;
};

export type ResolveDependencies = {
  readonly complete: (request: {
    messages: readonly ChatMessage[];
    tools?: readonly ToolSpec[];
  }) => Promise<Completion>;
};

const GUIDANCE_TOOL_NAME = "record_cancel_guidance";

const GUIDANCE_TOOL: ToolSpec = {
  type: "function",
  function: {
    name: GUIDANCE_TOOL_NAME,
    description:
      "Record cancellation steps for a merchant. Describe the settings screen and the " +
      "buttons, in the merchant's own words. Do NOT include a URL or a domain — an " +
      "invented link sends the user to a host that does not exist.",
    parameters: {
      type: "object",
      properties: {
        merchant: { type: "string", minLength: 1 },
        whereToLook: {
          type: "string",
          minLength: 1,
          maxLength: 200,
          description: "The settings path, e.g. 'Settings -> Account -> Subscription'.",
        },
        steps: {
          type: "array",
          items: { type: "string", minLength: 8, maxLength: 300 },
          minItems: 2,
          maxItems: 8,
        },
      },
      required: ["merchant", "whereToLook", "steps"],
      // `additionalProperties: false` is what makes "no URL" enforceable on the
      // wire. A model that returns one is told so by the provider, and if it
      // returns one anyway zod rejects the whole call.
      additionalProperties: false,
    },
  },
};

const UNVERIFIED =
  "Unverified steps, written by the agent and not confirmed against a vendor page. " +
  "Navigation may have changed.";

/** Used whenever the agent cannot produce something usable. Honest, not fatal. */
function unusable(merchant: string, why: string): CancelGuidance {
  const guide = getCancelGuide(merchant);
  return {
    merchant,
    verified: guide.key !== "generic",
    steps: guide.steps,
    whereToLook: null,
    assurance: guide.key === "generic" ? `${UNVERIFIED} (${why})` : "",
    guide: guide.key === "generic" ? null : guide,
  };
}

export async function resolveCancelGuide(
  merchant: string,
  deps: ResolveDependencies,
): Promise<CancelGuidance> {
  const trimmed = merchant.trim();
  if (trimmed.length === 0) return unusable("Subscription", "no merchant named");

  // The verified path first, and it does not consult the model. Rewriting an
  // answer we already hold is strictly worse than reading it.
  const known = getCancelGuide(trimmed);
  if (known.key !== "generic") {
    return {
      merchant: trimmed,
      verified: true,
      steps: known.steps,
      whereToLook: null,
      assurance: "",
      guide: known,
    };
  }

  const completion = await deps.complete({
    messages: [
      { role: "system", content: GUIDANCE_SYSTEM_PROMPT },
      { role: "user", content: `Merchant: ${trimmed}` },
    ],
    tools: [GUIDANCE_TOOL],
  });

  const call = completion.toolCalls.find((c) => c.name === GUIDANCE_TOOL_NAME);
  // No tool call at all is a normal outcome for a small model, not an error.
  // Degrading here is the point of build order 7.
  if (call === undefined) return unusable(trimmed, "the agent returned no steps");

  const parsed = GuidanceSchema.safeParse(call.args);
  if (!parsed.success) return unusable(trimmed, "the agent's answer did not validate");

  return {
    merchant: trimmed,
    verified: false,
    steps: parsed.data.steps,
    whereToLook: parsed.data.whereToLook,
    assurance: UNVERIFIED,
    guide: null,
  };
}

const GUIDANCE_SYSTEM_PROMPT = [
  "You help a merchant cancel a subscription they pay for.",
  "",
  "Describe where to go and what to click, using the merchant's own navigation words.",
  "Do not give a URL or a domain name. You cannot verify one, and a wrong link sends",
  "someone to a site that does not exist at the moment they need help. Describe the",
  "path instead: which app, which Settings section, which button.",
  "",
  "Be specific. 'Go to the website and cancel' is useless; 'Settings -> Account ->",
  "Subscription -> Cancel' is not.",
].join("\n");

export { GUIDANCE_TOOL, GUIDANCE_TOOL_NAME };