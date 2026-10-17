/**
 * Text hygiene for anything a model wrote that will be shown to someone.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SEPARATE MODULE
 * ---------------------------------------------------------------------------
 *
 * `cancelResolution.ts` already refuses URLs — as a schema on `CancelGuidance`,
 * with no `url` field and a refinement on every step. That is the right mechanism
 * there, because `CancelGuidance` is structured.
 *
 * `finalText` is not structured. It is the model's closing words, it is free text,
 * and it streams straight onto the run log on screen. A live run on 2026-10-17
 * produced
 *
 *     - Netflix: [Cancel your membership – Netflix Help Center](https://help.netflix.com/en/node/435)
 *
 * and the repo's own rule — "a cancellation link that 404s is worse than no
 * link" — did not apply to it, because a free-text string never passes through a
 * schema. This module is that rule applied to the one place it was missing.
 *
 * ---------------------------------------------------------------------------
 * WHY STRIP AND NOT REFUSE
 * ---------------------------------------------------------------------------
 *
 * Dropping the whole sentence because it contains a link would leave "Netflix:",
 * which teaches nobody and reads as a bug. Keeping the words and removing the link
 * leaves the part that is true and verifiable — the merchant, the instruction —
 * and discards the part that is invented. The link is the unverifiable part, and
 * it is the only part that can 404.
 */

/** `[label](https://…)` — collapsed to `label` before anything else runs. */
const MARKDOWN_LINK = /\[([^\]]*)\]\(\s*(?:https?:\/\/|www\.)[^)]*\)/gi;

/** A bare link, scheme or not. Trailing punctuation is left to the caller. */
const BARE_LINK = /(?:https?:\/\/|www\.)[^\s<>()]+/gi;

/**
 * Remove invented links, keeping the words around them.
 *
 * Order matters: markdown is collapsed first, because stripping the bare URL out
 * of `[label](https://x)` would leave `[label]` and its brackets behind.
 */
export function scrubUrls(text: string): string {
  const collapsed = text.replace(MARKDOWN_LINK, "$1");

  // Trailing sentence punctuation belongs to the sentence, not the URL, so it is
  // put back — otherwise "cancel at https://x.test." loses its full stop and the
  // next sentence runs into it.
  const stripped = collapsed
    .replace(BARE_LINK, (match) => {
      const tail = match.match(/[.,;:!?]+$/)?.[0] ?? "";
      return tail;
    })
    // One link removed from between two words leaves two spaces, which reads as a
    // rendering fault rather than as a deletion.
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+([.,;:!?])/g, "$1")
    .replace(/[ \t]+$/g, "")
    .trim();

  return stripped;
}

/**
 * True when the text contains anything link-shaped.
 *
 * Exported because the run log wants to *say* that it removed something. A model
 * answer silently missing its link looks like a rendering bug; one that says "the
 * model's link was removed" looks like a constraint.
 */
export function containsUrl(text: string): boolean {
  MARKDOWN_LINK.lastIndex = 0;
  BARE_LINK.lastIndex = 0;
  return MARKDOWN_LINK.test(text) || BARE_LINK.test(text);
}