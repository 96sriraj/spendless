import { describe, expect, it } from "vitest";
import { formatINR, formatINRCompact, lifetimeSavingsVsYearly, monthlyTotal, savingsEstimate, toMonthlyCents, toYearlyCents, yearlyEstimate, yearlySavingsFromMonthly, yearlySavingsVsMonthly } from "./money";

describe("money — formatINR", () => {
  it("should format 0 paise as INR zero", () => {
    const out = formatINR(0);
    expect(out).toContain("₹");
    // en-IN may use ₹0 or ₹0.00 — allow both
    expect(out.replace(/\s/g, "")).toMatch(/₹0(\.00)?/);
  });

  it("should format 49900 paise (₹499) with INR symbol", () => {
    const out = formatINR(49_900);
    expect(out).toContain("₹");
    expect(out).toContain("499");
  });

  it("should preserve paise fractional digits for non-whole rupees", () => {
    const out = formatINR(49_950); // ₹499.50
    expect(out).toContain("₹");
    // maximumFractionDigits 2, so 499.5 should show .5 or .50
    expect(out).toMatch(/499[.,]5/);
  });

  it("should format large amount with en-IN grouping", () => {
    const out = formatINR(1_23_456_00); // ₹1,23,456
    expect(out).toContain("₹");
    expect(out.replace(/\s/g, "").replace(/₹/, "")).toMatch(/1,23,456/);
  });
});

describe("money — toMonthlyCents", () => {
  it("should return same amount for monthly", () => {
    expect(toMonthlyCents(49_900, "monthly")).toBe(49_900);
  });

  it("should divide yearly by 12 rounded", () => {
    // 30,000 yearly => 2,500 monthly
    expect(toMonthlyCents(30_000, "yearly")).toBe(2_500);
    // 29,999 yearly => Math.round(2499.916) = 2500
    expect(toMonthlyCents(29_999, "yearly")).toBe(2_500);
  });

  it("should convert weekly via 52/12 factor", () => {
    // 1_200 weekly => Math.round(1200*52/12) = 5_200
    expect(toMonthlyCents(1_200, "weekly")).toBe(5_200);
    // 100 weekly => 433
    expect(toMonthlyCents(100, "weekly")).toBe(433);
  });

  it("should round yearly edge 100 paise", () => {
    expect(toMonthlyCents(100, "yearly")).toBe(8); // 8.333 -> 8
  });
});

describe("money — toYearlyCents", () => {
  it("should annualize monthly *12", () => {
    expect(toYearlyCents(49900, "monthly")).toBe(49900 * 12);
  });
  it("should return same for yearly", () => {
    expect(toYearlyCents(299900, "yearly")).toBe(299900);
  });
  it("should annualize weekly *52", () => {
    expect(toYearlyCents(100, "weekly")).toBe(5200);
    expect(toYearlyCents(1200, "weekly")).toBe(62400);
  });
});

describe("money — yearlyEstimate + monthlyTotal", () => {
  it("should sum mixed cycles monthly then annualize", () => {
    const subs = [
      { amountCents: 49900, billingCycle: "monthly" as const },
      { amountCents: 299900, billingCycle: "yearly" as const },
      { amountCents: 1200, billingCycle: "weekly" as const },
    ];
    const expectedMonthly = 49900 + Math.round(299900 / 12) + Math.round((1200 * 52) / 12);
    expect(monthlyTotal(subs)).toBe(expectedMonthly);
    expect(yearlyEstimate(subs)).toBe(expectedMonthly * 12);
  });
  it("should return 0 for empty list", () => {
    expect(monthlyTotal([])).toBe(0);
    expect(yearlyEstimate([])).toBe(0);
  });
});

describe("money — formatINRCompact", () => {
  it("should contain INR symbol and be compact for large values", () => {
    const out = formatINRCompact(1_23_45_678_00);
    expect(out).toContain("₹");
    expect(out.length).toBeGreaterThan(1);
  });
  it("should fallback to normal format for <1000 rupees", () => {
    const compact = formatINRCompact(50000);
    const normal = formatINR(50000);
    expect(compact).toBe(normal);
  });
  it("should compact lakhs with notation", () => {
    const out = formatINRCompact(10_00_000_00);
    expect(out).toContain("₹");
  });
});

describe("money — savings", () => {
  it("should compute savingsEstimate as monthly sum", () => {
    const subs = [
      { amountCents: 49900, billingCycle: "monthly" as const },
      { amountCents: 120000, billingCycle: "yearly" as const },
    ];
    expect(savingsEstimate(subs)).toBe(monthlyTotal(subs));
  });
  it("should annualize via yearlySavingsFromMonthly", () => {
    expect(yearlySavingsFromMonthly(5000)).toBe(60000);
    expect(yearlySavingsFromMonthly(0)).toBe(0);
  });
  it("should weekly→monthly factor applied in totals", () => {
    const weekly = [{ amountCents: 500, billingCycle: "weekly" as const }];
    expect(monthlyTotal(weekly)).toBe(Math.round((500 * 52) / 12));
    expect(yearlyEstimate(weekly)).toBe(Math.round((500 * 52) / 12) * 12);
  });
});

describe("money — yearlySavingsVsMonthly", () => {
  it("should default yearly price to 50% of the 12x monthly total", () => {
    const res = yearlySavingsVsMonthly(49_900);
    expect(res.monthlyYearTotalCents).toBe(49_900 * 12);
    expect(res.yearlyCents).toBe(Math.round(49_900 * 12 * 0.5));
    expect(res.savedCents).toBe(49_900 * 12 - Math.round(49_900 * 12 * 0.5));
    expect(res.percent).toBe(50);
  });

  it("should use an explicit yearly price when provided", () => {
    const monthly = 10_000;
    const yearly = 90_000; // vs 120_000 for 12 months
    const res = yearlySavingsVsMonthly(monthly, yearly);
    expect(res.monthlyYearTotalCents).toBe(120_000);
    expect(res.yearlyCents).toBe(90_000);
    expect(res.savedCents).toBe(30_000);
    expect(res.percent).toBe(25);
  });

  it("should clamp savings to zero when yearly costs more than monthly", () => {
    const res = yearlySavingsVsMonthly(1_000, 20_000); // 12x monthly = 12_000
    expect(res.savedCents).toBe(0);
    expect(res.percent).toBe(0);
  });

  it("should return zero percent when there is no monthly spend", () => {
    const res = yearlySavingsVsMonthly(0);
    expect(res.monthlyYearTotalCents).toBe(0);
    expect(res.savedCents).toBe(0);
    expect(res.percent).toBe(0);
  });
});

describe("money — lifetimeSavingsVsYearly", () => {
  it("should compute a 3-year horizon and savings over lifetime price", () => {
    const res = lifetimeSavingsVsYearly(30_000, 79_900);
    expect(res.threeYearCents).toBe(90_000);
    expect(res.savedCents).toBe(90_000 - 79_900);
  });

  it("should clamp savings to zero when lifetime costs more than 3 years yearly", () => {
    const res = lifetimeSavingsVsYearly(10_000, 79_900); // 3yr = 30_000
    expect(res.threeYearCents).toBe(30_000);
    expect(res.savedCents).toBe(0);
  });
});
