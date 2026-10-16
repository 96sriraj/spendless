import { describe, expect, it } from "vitest";
import { describeFreshness, readReportingFreshness, type ReportingFreshness } from "./freshness";

/**
 * Transaction Search is cached and lags behind the capture API. PayPal's docs
 * say "a maximum of three hours"; developers report far worse in practice.
 *
 * That matters here for a specific reason: the seed captures a payment, then
 * immediately asks whether the merchant-authored identity survived the round
 * trip. Until tonight that question could only be answered by sleeping and
 * guessing at how long to sleep. The response carries `last_refreshed_datetime`,
 * which turns "wait three hours" into a measurement — and into a *falsifiable*
 * one, because it says how stale the data actually was.
 *
 * Without it, "still not seeded" is indistinguishable from "will never be".
 */

const at = (iso: string) => Date.parse(iso);

describe("readReportingFreshness", () => {
  it("should read the timestamp PayPal says its cache was last refreshed at", () => {
    const fresh = readReportingFreshness(
      { last_refreshed_datetime: "2026-10-17T02:00:00+0000" },
      at("2026-10-17T05:00:00Z"),
    );

    expect(fresh.lastRefreshed).toBe("2026-10-17T02:00:00+0000");
  });

  it("should measure how stale the data actually is", () => {
    const fresh = readReportingFreshness(
      { last_refreshed_datetime: "2026-10-17T02:00:00+0000" },
      at("2026-10-17T05:30:00Z"),
    );

    expect(fresh.ageMs).toBe(3.5 * 60 * 60 * 1000);
  });

  it("should return null age when the response omits the field", () => {
    // Not an error worth crashing on. An absent field just means we cannot say
    // how stale the data is, which is different from saying it is fresh.
    const fresh = readReportingFreshness({}, at("2026-10-17T05:30:00Z"));

    expect(fresh.lastRefreshed).toBeNull();
    expect(fresh.ageMs).toBeNull();
  });

  it("should return null age rather than NaN for an unparseable timestamp", () => {
    // NaN propagates silently and turns "3 hours stale" into "NaN hours stale"
    // at the print site, which is exactly when nobody is looking.
    const fresh = readReportingFreshness(
      { last_refreshed_datetime: "not-a-date" },
      at("2026-10-17T05:30:00Z"),
    );

    expect(fresh.lastRefreshed).toBe("not-a-date");
    expect(fresh.ageMs).toBeNull();
  });

  it("should tolerate PayPal's +0000 offset as well as a Z suffix", () => {
    // PayPal emits +0000, not Z. Date.parse handles both, but the difference
    // is the kind of thing that silently becomes a local-timezone bug.
    expect(
      readReportingFreshness(
        { last_refreshed_datetime: "2026-10-17T02:00:00+0000" },
        at("2026-10-17T05:00:00Z"),
      ).ageMs,
    ).toBe(3 * 60 * 60 * 1000);
  });
});

describe("describeFreshness", () => {
  it("should say a payment captured now cannot be visible yet", () => {
    // The actual situation on 2026-10-17: a capture one second old, read from a
    // cache refreshed three hours ago. This is not a failure, and saying so
    // matters more than the number.
    const fresh = readReportingFreshness(
      { last_refreshed_datetime: "2026-10-17T02:00:00+0000" },
      at("2026-10-17T05:30:00Z"),
    );

    expect(describeFreshness(fresh)).toContain("2026-10-17T02:00:00+0000");
    expect(describeFreshness(fresh)).toContain("3h 30m");
    expect(describeFreshness(fresh)).toMatch(/too fresh|lag|behind/i);
  });

  it("should not claim a lag when it cannot measure one", () => {
    const text = describeFreshness(readReportingFreshness({}, 0));

    expect(text).toMatch(/no freshness/i);
    expect(text).not.toMatch(/NaN/);
  });

  it("should report a cache that is ahead of our clock without going negative", () => {
    // Clock skew between our machine and PayPal's is real and produces a
    // negative age, which would render as "-0h 5m" and read as nonsense. The
    // assertion is on the rendered age, not on hyphens — the ISO timestamp it
    // sits next to is full of them.
    const fresh: ReportingFreshness = {
      lastRefreshed: "2026-10-17T06:00:00+0000",
      ageMs: -5 * 60 * 1000,
    };
    const text = describeFreshness(fresh);

    expect(text).toMatch(/skew/i);
    expect(text).not.toMatch(/-\d+\s*h/);
    expect(text).not.toMatch(/-\d+\s*m\b/);
  });
});
