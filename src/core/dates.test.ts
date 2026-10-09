import { describe, expect, it } from "vitest";
import { daysUntilRenewal, formatDisplayDate, isRenewalSoon, isValidIsoDateString, renewalOffsets, trialWatchOffset } from "./dates";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function isoAt(ms: number): string {
  return new Date(ms).toISOString();
}

describe("dates — daysUntilRenewal", () => {
  it("should ceil fractional days", () => {
    const now = Date.parse("2026-09-08T10:00:00.000Z");
    const target = isoAt(now + 2.1 * MS_PER_DAY);
    expect(daysUntilRenewal(target, now)).toBe(3);
  });
  it("should return 0 when same instant", () => {
    const now = Date.now();
    expect(daysUntilRenewal(isoAt(now), now)).toBe(0);
  });
  it("should return negative for past renewal", () => {
    const now = Date.parse("2026-09-08T00:00:00.000Z");
    const past = isoAt(now - MS_PER_DAY);
    expect(daysUntilRenewal(past, now)).toBe(-1);
  });
  it("should handle midnight boundary exact", () => {
    const now = Date.parse("2026-09-08T00:00:00.000Z");
    const midnightNext = isoAt(now + MS_PER_DAY);
    expect(daysUntilRenewal(midnightNext, now)).toBe(1);
    expect(daysUntilRenewal(isoAt(now + 0.1 * MS_PER_DAY), now)).toBe(1);
  });
  it("should return NaN for invalid ISO", () => {
    expect(daysUntilRenewal("not-a-date")).toBeNaN();
  });
});

describe("dates — isRenewalSoon", () => {
  it("should be true within 3 days default", () => {
    const now = Date.parse("2026-09-08T00:00:00.000Z");
    expect(isRenewalSoon(isoAt(now + 2 * MS_PER_DAY), 3, now)).toBe(true);
    expect(isRenewalSoon(isoAt(now + 3 * MS_PER_DAY), 3, now)).toBe(true);
    expect(isRenewalSoon(isoAt(now + 4 * MS_PER_DAY), 3, now)).toBe(false);
  });
  it("should respect 1 and 7 day windows", () => {
    const now = Date.parse("2026-09-08T00:00:00.000Z");
    expect(isRenewalSoon(isoAt(now + 1 * MS_PER_DAY), 1, now)).toBe(true);
    expect(isRenewalSoon(isoAt(now + 2 * MS_PER_DAY), 1, now)).toBe(false);
    expect(isRenewalSoon(isoAt(now + 7 * MS_PER_DAY), 7, now)).toBe(true);
    expect(isRenewalSoon(isoAt(now + 8 * MS_PER_DAY), 7, now)).toBe(false);
  });
  it("should be false for past renewal", () => {
    const now = Date.parse("2026-09-08T00:00:00.000Z");
    expect(isRenewalSoon(isoAt(now - MS_PER_DAY), 3, now)).toBe(false);
  });
  it("should be false for invalid ISO", () => {
    expect(isRenewalSoon("bad-date", 3)).toBe(false);
  });
});

describe("dates — renewalOffsets", () => {
  // Clock is injected, never faked. AGENTS.md: timing is injected, never
  // slept. `renewalOffsets` was Nixt's one date helper that read Date.now()
  // directly, and the architecture gate caught it.
  const now = Date.parse("2026-09-08T00:00:00.000Z");

  it("should return 3 offsets when renewal far future", () => {
    const future = isoAt(now + 10 * MS_PER_DAY);
    const offsets = renewalOffsets(future, now);
    expect(offsets).toEqual([
      isoAt(now + 7 * MS_PER_DAY),
      isoAt(now + 9 * MS_PER_DAY),
      isoAt(now + 10 * MS_PER_DAY - 60 * 60 * 1000),
    ]);
  });
  it("should filter past offsets (near renewal yields fewer)", () => {
    const near = isoAt(now + 2 * MS_PER_DAY);
    // 3d-before has already passed (now - 1d); 1d-before and 1h-before remain.
    const offsets = renewalOffsets(near, now);
    expect(offsets).toEqual([
      isoAt(now + MS_PER_DAY),
      isoAt(now + 2 * MS_PER_DAY - 60 * 60 * 1000),
    ]);
    for (const o of offsets) expect(Date.parse(o)).toBeGreaterThan(now);
  });
  it("should return empty for past renewal", () => {
    const past = isoAt(now - MS_PER_DAY);
    expect(renewalOffsets(past, now).length).toBe(0);
  });
  it("should return empty for invalid ISO", () => {
    expect(renewalOffsets("not-date", now).length).toBe(0);
  });
});

describe("dates — trialWatchOffset (F1)", () => {
  it("should return the instant exactly 2 days before trial end", () => {
    const now = Date.parse("2026-09-08T00:00:00.000Z");
    const trialEnd = isoAt(now + 5 * MS_PER_DAY);
    const off = trialWatchOffset(trialEnd, now);
    expect(off).not.toBeNull();
    expect(Date.parse(off as string)).toBe(now + 3 * MS_PER_DAY);
  });
  it("should return null when 2-days-before is already past", () => {
    const now = Date.parse("2026-09-08T00:00:00.000Z");
    // trial ends in 1 day -> 2-days-before is in the past
    expect(trialWatchOffset(isoAt(now + 1 * MS_PER_DAY), now)).toBeNull();
  });
  it("should return null when 2-days-before equals now (boundary)", () => {
    const now = Date.parse("2026-09-08T00:00:00.000Z");
    expect(trialWatchOffset(isoAt(now + 2 * MS_PER_DAY), now)).toBeNull();
  });
  it("should return null for a past trial end", () => {
    const now = Date.parse("2026-09-08T00:00:00.000Z");
    expect(trialWatchOffset(isoAt(now - MS_PER_DAY), now)).toBeNull();
  });
  it("should return null for invalid ISO", () => {
    expect(trialWatchOffset("not-a-date")).toBeNull();
  });
});

describe("dates — formatDisplayDate / isValidIsoDateString", () => {
  it("should format valid date with en-IN", () => {
    const out = formatDisplayDate("2026-09-08T00:00:00.000Z");
    expect(out).not.toBe("—");
    expect(out).toContain("2026");
  });
  it("should return em dash for invalid", () => {
    expect(formatDisplayDate("bad")).toBe("—");
  });
  it("should validate ISO strings", () => {
    expect(isValidIsoDateString("2026-09-08T00:00:00.000Z")).toBe(true);
    expect(isValidIsoDateString("not-a-date")).toBe(false);
  });
});
