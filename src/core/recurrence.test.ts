import { describe, expect, it } from "vitest";
import {
  analyse,
  cadenceForGap,
  inferRecurrence,
  MIN_CHARGES_FOR_RECURRENCE,
  type Series,
} from "./recurrence";


const DAY = 86_400_000;
const BASE = Date.parse("2026-01-15T00:00:00.000Z");

function monthlySeries(
  overrides: { amounts?: number[]; cadenceDays?: number } = {},
): Series {
  const gap = overrides.cadenceDays ?? 30;
  const amounts = overrides.amounts ?? [1_599, 1_599, 1_599, 1_599];
  return {
    merchantKey: "sub-netflix",
    currencyCode: "USD",
    amounts,
    dates: amounts.map((_, i) => new Date(BASE + i * gap * DAY).toISOString()),
  };
}

describe("recurrence — cadenceForGap", () => {
  it("should bucket a four-weekly gap as monthly", () => {
    expect(cadenceForGap(28)).toBe("monthly");
  });

  it("should bucket a calendar month as monthly", () => {
    expect(cadenceForGap(31)).toBe("monthly");
  });

  // A real subscription billed on the 31st hits a 28-day gap in February.
  // Two weeks' drift must not knock it off the monthly rung.
  it("should keep a February gap on the monthly rung", () => {
    expect(cadenceForGap(28)).toBe("monthly");
    expect(cadenceForGap(35)).toBe("monthly");
  });

  it("should bucket a weekly gap", () => {
    expect(cadenceForGap(7)).toBe("weekly");
  });

  it("should bucket a yearly gap", () => {
    expect(cadenceForGap(365)).toBe("yearly");
  });

  it("should call anything else irregular", () => {
    expect(cadenceForGap(3)).toBe("irregular");
    expect(cadenceForGap(120)).toBe("irregular");
  });

  it("should reject a non-positive or non-finite gap", () => {
    expect(cadenceForGap(0)).toBe("irregular");
    expect(cadenceForGap(-5)).toBe("irregular");
    expect(cadenceForGap(Number.NaN)).toBe("irregular");
  });
});

describe("recurrence — analyse", () => {
  it("should recognise a monthly subscription", () => {
    const r = analyse(monthlySeries());
    expect(r.cadence).toBe("monthly");
    expect(r.isRecurring).toBe(true);
    expect(r.medianGapDays).toBe(30);
    expect(r.medianAmountCents).toBe(1_599);
    expect(r.amountIsStable).toBe(true);
  });

  it("should not call a single charge recurring", () => {
    const r = analyse(monthlySeries({ amounts: [1_599] }));
    expect(r.isRecurring).toBe(false);
    expect(r.medianGapDays).toBeNull();
  });

  it("should not call two charges recurring", () => {
    const r = analyse(monthlySeries({ amounts: [1_599, 1_599] }));
    expect(r.isRecurring).toBe(false);
    expect(r.chargeCount).toBe(MIN_CHARGES_FOR_RECURRENCE - 1);
  });

  it("should call three equal monthly charges recurring", () => {
    expect(analyse(monthlySeries({ amounts: [1_599, 1_599, 1_599] })).isRecurring).toBe(
      true,
    );
  });

  // Three equal monthly charges is a subscription. Three equal charges at
  // irregular intervals is noise, and the ranking path must not call it a
  // recurring commitment the user can cancel.
  it("should not call evenly-spaced-but-odd-interval charges recurring", () => {
    const r = analyse(monthlySeries({ amounts: [1_599, 1_599, 1_599, 1_599], cadenceDays: 11 }));
    expect(r.cadence).toBe("irregular");
    expect(r.isRecurring).toBe(false);
    // The regularity is still reported, just not acted on.
    expect(r.amountIsStable).toBe(true);
  });

  it("should tolerate a small price variation", () => {
    const r = analyse(monthlySeries({ amounts: [1_599, 1_599, 1_620, 1_599] }));
    expect(r.amountIsStable).toBe(true);
    expect(r.isRecurring).toBe(true);
  });

  it("should refuse to call a rising series a subscription", () => {
    // Escalating amounts are a price hike, which is a different detector with
    // a different action. Calling it "recurring" here would double-count it.
    const r = analyse(monthlySeries({ amounts: [1_000, 1_500, 2_000, 2_500] }));
    expect(r.amountIsStable).toBe(false);
    expect(r.isRecurring).toBe(false);
  });

  it("should ignore unparseable dates when measuring gaps", () => {
    const r = analyse({
      merchantKey: "m",
      currencyCode: "USD",
      amounts: [1_599, 1_599, 1_599],
      dates: ["not-a-date", "also-bad", "still-bad"],
    });
    expect(r.medianGapDays).toBeNull();
    expect(r.isRecurring).toBe(false);
  });

  it("should be order-independent", () => {
    const forward = analyse(monthlySeries());
    const reversed = analyse({
      ...monthlySeries(),
      amounts: [...monthlySeries().amounts].reverse(),
      dates: [...monthlySeries().dates].reverse(),
    });
    expect(reversed).toEqual(forward);
  });
});

describe("recurrence — inferRecurrence", () => {
  const t = (
    merchantKey: string,
    capturedAt: string,
    amountCents: number,
    identitySource = "seed_invoice_id",
    currencyCode: string = "USD",
  ) => ({ merchantKey, identitySource, amountCents, currencyCode, capturedAt });

  it("should group by merchant and find the subscription", () => {
    const result = inferRecurrence([
      t("sub-netflix", "2026-01-15T00:00:00.000Z", 1_599),
      t("sub-netflix", "2026-02-14T00:00:00.000Z", 1_599),
      t("sub-netflix", "2026-03-16T00:00:00.000Z", 1_599),
      t("sub-spotify", "2026-01-02T00:00:00.000Z", 999),
      t("sub-spotify", "2026-01-09T00:00:00.000Z", 999),
    ]);

    const netflix = result.find((r) => r.merchantKey === "sub-netflix");
    expect(netflix?.isRecurring).toBe(true);
    expect(netflix?.cadence).toBe("monthly");

    const spotify = result.find((r) => r.merchantKey === "sub-spotify");
    expect(spotify?.isRecurring).toBe(false);
    expect(spotify?.cadence).toBe("weekly");
  });

  // The unattributable case is real: Transaction Search returns rows we cannot
  // name. Lumping them together would manufacture a series out of unrelated
  // charges and call it a subscription.
  it("should drop transactions with no usable identity rather than invent a series", () => {
    const result = inferRecurrence([
      t("unknown-a", "2026-01-15T00:00:00.000Z", 1_599, "unknown"),
      t("unknown-b", "2026-02-15T00:00:00.000Z", 1_599, "unknown"),
      t("unknown-c", "2026-03-15T00:00:00.000Z", 1_599, "unknown"),
    ]);
    expect(result).toEqual([]);
  });

  it("should not merge merchants that happen to share a key across currencies", () => {
    const result = inferRecurrence([
      t("m", "2026-01-15T00:00:00.000Z", 1_599, "seed_invoice_id", "USD"),
      t("m", "2026-02-15T00:00:00.000Z", 64_900, "seed_invoice_id", "INR"),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]?.chargeCount).toBe(1);
  });

  it("should rank recurring findings first, then by size, then stably by key", () => {
    const result = inferRecurrence([
      t("sub-small", "2026-01-05T00:00:00.000Z", 500),
      t("sub-small", "2026-02-05T00:00:00.000Z", 500),
      t("sub-small", "2026-03-05T00:00:00.000Z", 500),
      t("sub-noise", "2026-01-01T00:00:00.000Z", 9_000),
      t("sub-noise", "2026-01-09T00:00:00.000Z", 9_000),
      t("sub-big", "2026-01-15T00:00:00.000Z", 5_000),
      t("sub-big", "2026-02-14T00:00:00.000Z", 5_000),
      t("sub-big", "2026-03-16T00:00:00.000Z", 5_000),
    ]);

    expect(result.map((r) => r.merchantKey)).toEqual(["sub-big", "sub-small", "sub-noise"]);
  });

  it("should return nothing for an empty stream", () => {
    expect(inferRecurrence([])).toEqual([]);
  });

  /**
   * The field the renewal projection needs and did not have.
   *
   * Without `lastChargeAt` the only way to guess a renewal date is `now + gap`,
   * which is correct exactly once per billing cycle — on the day the charge
   * landed. A merchant is usually a few days *before* a renewal, and that is
   * precisely the moment the product has something to say. So the last observed
   * charge has to travel with the inference rather than be reconstructed.
   */
  describe("lastChargeAt", () => {
    it("should report the most recent charge, not the median position", () => {
      const result = inferRecurrence([
        t("sub-a", "2026-01-05T00:00:00.000Z", 500),
        t("sub-a", "2026-03-05T00:00:00.000Z", 500),
        t("sub-a", "2026-02-05T00:00:00.000Z", 500),
      ]);

      expect(result[0]?.lastChargeAt).toBe("2026-03-05T00:00:00.000Z");
    });

    it("should report the last charge even when the series is not recurring", () => {
      // A single charge has no gap and no cadence, but it still happened, and a
      // caller reconstructing a renewal from it needs the date.
      const result = inferRecurrence([t("sub-one", "2026-03-05T00:00:00.000Z", 500)]);

      expect(result[0]?.lastChargeAt).toBe("2026-03-05T00:00:00.000Z");
    });

    it("should be null when a date in the series cannot be parsed", () => {
      // A nonsense date is dropped from the gap calculation already. Carrying
      // it forward as a renewal anchor would put a renewal in the year 5000.
      const result = analyse({
        merchantKey: "sub-bad",
        currencyCode: "USD",
        amounts: [500, 500],
        dates: ["not-a-date"],
      });

      expect(result.lastChargeAt).toBeNull();
    });

    it("should be null for a series with no dates at all", () => {
      const result = analyse({
        merchantKey: "sub-empty",
        currencyCode: "USD",
        amounts: [],
        dates: [],
      });

      expect(result.lastChargeAt).toBeNull();
    });
  });
});