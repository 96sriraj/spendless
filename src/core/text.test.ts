import { describe, expect, it } from "vitest";
import { scrubUrls } from "./text";

/**
 * Keeping invented links out of what the screen shows.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS, GIVEN `cancelResolution.ts` ALREADY REFUSES URLS
 * ---------------------------------------------------------------------------
 *
 * That guard is a schema on `CancelGuidance`: no `url` field, and every step and
 * `whereToLook` is refused if it contains one. It does not cover `finalText` —
 * the model's own closing words — because that string is free text and never
 * passes through the schema.
 *
 * A live run on 2026-10-17 produced:
 *
 *     - Netflix: [Cancel your membership – Netflix Help Center](https://help.netflix.com/en/node/435)
 *
 * streamed to the browser as the run's closing line. The model produced that link
 * from its own memory; nothing in the repo verified it, and the repo's own stated
 * rule is that "a cancellation link that 404s is worse than no link". Showing a
 * judge an invented URL is the single most damaging thing this screen could do,
 * because it is indistinguishable from the product having verified it.
 *
 * So the same rule is applied to the one string it was not applied to. Not by
 * dropping the sentence — a bare "Netflix:" teaches nobody — but by stripping the
 * link and keeping the words around it.
 */

/**
 * A link the model wrote, with the words that describe it kept.
 *
 * Markdown links collapse to their label first, because a bare-URL strip would
 * otherwise leave the reader with `[Cancel your membership]` and the brackets
 * behind.
 */
describe("scrubUrls", () => {
  it("keeps the words and drops the link from a markdown link", () => {
    expect(
      scrubUrls("Netflix: [Cancel your membership](https://help.netflix.com/en/node/435)"),
    ).toBe("Netflix: Cancel your membership");
  });

  it("removes a bare URL that is not markdown", () => {
    expect(scrubUrls("Go to https://help.netflix.com/en/node/435 and cancel.")).toBe(
      "Go to and cancel.",
    );
  });

  it("removes a bare domain, which is a URL the model wrote without a scheme", () => {
    expect(scrubUrls("Visit www.example.com/settings today.")).toBe("Visit today.");
  });

  it("leaves ordinary prose completely untouched", () => {
    const prose = "Cancel from the account page. Adobe refunds are automatic.";
    expect(scrubUrls(prose)).toBe(prose);
  });

  it("handles several links in one answer", () => {
    expect(scrubUrls("[a](https://x.test) and [b](http://y.test)")).toBe("a and b");
  });

  it("does not mangle parentheses that are not links", () => {
    // "Netflix (annual plan)" is not a URL, and a regex hungry enough to eat it
    // would quietly corrupt the merchant's name.
    expect(scrubUrls("Netflix (annual plan) is idle.")).toBe("Netflix (annual plan) is idle.");
  });

  it("collapses the gap a removed link leaves, so the sentence does not read broken", () => {
    // "Go to  and cancel." with a double space looks like a rendering bug. One
    // space is the honest result of a word having been taken out.
    expect(scrubUrls("Go to https://x.test and cancel.")).toBe("Go to and cancel.");
  });

  it("returns an empty string rather than throwing when the answer is only a link", () => {
    expect(scrubUrls("https://x.test")).toBe("");
  });

  it("strips a link but keeps its label even when the label itself contains a dot", () => {
    // "help.netflix.com" as link text is the shape a model reaches for.
    expect(scrubUrls("[help.netflix.com](https://help.netflix.com)")).toBe("help.netflix.com");
  });
});