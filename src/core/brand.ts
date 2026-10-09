/**
 * Single source of truth for spendless brand.
 * Every brand-visible string must derive from these constants.
 *
 * Lifted from nixt, which is a sibling project, not a previous name for this
 * one. Kept: the shape - one file, no scattered literals, pageTitle composing
 * the wordmark. Dropped: the bundle id, App Store id and store-review deep
 * link, because the README locks spendless to web-first. There is no app to
 * deep link into, and exporting identifiers that belong to another repo is how
 * the wrong product ships under the right name.
 */

export const BRAND_NAME = "spendless - The AI agent that spends less, not more" as const;

export const SHORT_BRAND_NAME = "spendless" as const;

/** The positioning line the README leads with. Used verbatim in headers. */
export const BRAND_TAGLINE = "The AI agent that spends less, not more." as const;

/** Default <title> suffix used by page-level titles. */
export function pageTitle(page: string): string {
  // Nixt's version returned " — Nixt" for a blank page. A dangling separator
  // in a document title is noise, so an empty page yields the bare wordmark.
  const trimmed = page.trim();
  return trimmed.length === 0
    ? SHORT_BRAND_NAME
    : `${trimmed} — ${SHORT_BRAND_NAME}`;
}

export const BRAND_COLORS = {
  primary: "#0a7ea4",
  background: "#ffffff",
} as const;