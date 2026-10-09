import { describe, expect, it } from "vitest";
import { createCsvAccountSource, parseAmountToCents } from "./parsePayPalCsv";
import { UnsupportedCapabilityError, type DateRange } from "../AccountSource";
import { inferRecurrence } from "@/core/recurrence";

/**
 * A realistic slice of a PayPal activity export, including the things real
 * exports do that break naive parsers: a preamble before the header, quoted
 * fields containing commas and quotes, a trailing blank line, and a BOM.
 *
 * Dates are DD/MM/YYYY because every day-of-month here is the 25th, which
 * forces the parser to detect the order from the data rather than assume it.
 * That detection is tested separately below, because guessing it wrong would
 * shift every renewal window in the product.
 */
const EXPORT = [
  "Date,Time,TimeZone,Name,Type,Status,Currency,Gross,Fee,Net,From Email Address,To Email Address,Transaction ID,Balance",
  '"25/05/2026","14:22:10","UTC","Netflix","Recurring Payment","Completed","USD","-15.99","-1.32","-17.31","me@example.com","billing@netflix.com","TXN0001","100.00"',
  '"25/06/2026","14:22:10","UTC","Netflix","Recurring Payment","Completed","USD","-15.99","-1.32","-17.31","me@example.com","billing@netflix.com","TXN0002","117.31"',
  '"25/07/2026","14:22:10","UTC","Netflix","Recurring Payment","Completed","USD","-15.99","-1.32","-17.31","me@example.com","billing@netflix.com","TXN0003","134.64"',
  '"25/08/2026","14:22:10","UTC","Netflix","Recurring Payment","Completed","USD","-15.99","-1.32","-17.31","me@example.com","billing@netflix.com","TXN0004","151.97"',
  '"02/09/2026","09:00:00","UTC","Spotify","Website Payment","Completed","USD","-11.99","-1.03","-13.02","me@example.com","pay@spotify.com","TXN0005","140.98"',
  '"04/06/2026","11:00:00","UTC","O\'Brien, Ltd","Website Payment","Completed","USD","-40.00","-1.80","-41.80","me@example.com","billing@obrien.example","TXN0006","-2.00"',
  '"06/04/2026","12:00:00","UTC","Refund from Adobe","Refund","Completed","USD","12.99","0.00","12.99","billing@adobe.com","me@example.com","TXN0007","10.99"',
  "",
].join("\n");

const RANGE: DateRange = {
  start: new Date("2025-01-01T00:00:00.000Z"),
  end: new Date("2027-01-01T00:00:00.000Z"),
};

async function rows(text = EXPORT): ReturnType<typeof createCsvAccountSource> extends never ? never : Promise<Awaited<ReturnType<ReturnType<typeof createCsvAccountSource>["listTransactions"]>>> {
  return createCsvAccountSource(text).listTransactions(RANGE);
}

describe("parsePayPalCsv — header discovery", () => {
  it("should find the header row behind a preamble", async () => {
    const withPreamble = [
      "PayPal Activity Download",
      "Account: me@example.com",
      "Period: 2026-05-01 to 2026-09-30",
      "",
      EXPORT,
    ].join("\n");
    expect((await rows(withPreamble)).length).toBe(7);
  });

  it("should tolerate a UTF-8 BOM", async () => {
    expect((await rows(`\uFEFF${EXPORT}`)).length).toBe(7);
  });

  it("should reject content with no recognisable header", () => {
    expect(() => createCsvAccountSource("hello,world\n1,2\n")).toThrow(/activity export/i);
  });

  it("should reject empty content", () => {
    expect(() => createCsvAccountSource("")).toThrow();
  });
});

describe("parsePayPalCsv — date order detection", () => {
  // PayPal localises its export. A US export is MM/DD/YYYY; most of the rest
  // of the world is DD/MM/YYYY. Assuming the wrong one does not throw - it
  // silently swaps every month, which moves every renewal window and makes the
  // product confidently wrong.
  it("should detect DD/MM from a day above 12", async () => {
    const t = (await rows())[0];
    expect(t?.capturedAt).toBe("2026-05-25T14:22:10.000Z");
  });

  it("should detect MM/DD from a day above 12 in the second position", async () => {
    // Swap day and month on every row, so the same account reads as a US export.
    const us = EXPORT.replace(
      /"(\d{2})\/(\d{2})\/(\d{4})"/g,
      (_m, d: string, mo: string, y: string) => `"${mo}/${d}/${y}"`,
    );
    // "05/25/2026" can only be MM/DD.
    expect((await rows(us))[0]?.capturedAt).toBe("2026-05-25T14:22:10.000Z");
  });

  it("should refuse an export whose date order it cannot determine", () => {
    // Collapse every date to 05/05/2026: both components are <= 12, so MM/DD
    // and DD/MM are indistinguishable. Guessing is the one option guaranteed
    // to be wrong for half the users.
    const ambiguous = EXPORT.replace(/"(\d{2})\/(\d{2})\/(\d{4})"/g, '"05/05/2026"');
    expect(() => createCsvAccountSource(ambiguous)).toThrow(/date format/i);
  });
});

describe("parsePayPalCsv — amounts", () => {
  it("should parse a decimal string into integer minor units", () => {
    expect(parseAmountToCents("15.99")).toBe(1_599);
    expect(parseAmountToCents("-15.99")).toBe(-1_599);
    expect(parseAmountToCents("15")).toBe(1_500);
    expect(parseAmountToCents("15.9")).toBe(1_590);
  });

  it("should strip a currency symbol", () => {
    expect(parseAmountToCents("$15.99")).toBe(1_599);
  });

  it("should return null rather than NaN for junk", () => {
    expect(parseAmountToCents("n/a")).toBeNull();
    expect(parseAmountToCents("")).toBeNull();
    expect(parseAmountToCents("1.2.3")).toBeNull();
  });

  // The core compares amounts and ranks findings by them. A negative charge
  // silently flipped the sign of every finding.
  it("should report a payment made as a positive charge", async () => {
    const t = (await rows()).filter((r) => r.id === "TXN0001")[0];
    expect(t?.amountCents).toBe(1_599);
  });

  it("should report a refund as positive too, because money came back", async () => {
    const refund = (await rows()).filter((r) => r.id === "TXN0007")[0];
    expect(refund?.amountCents).toBe(1_299);
  });

  it("should mark a refund row reversed even when the export says Completed", async () => {
    const refund = (await rows()).filter((r) => r.id === "TXN0007")[0];
    expect(refund?.status).toBe("reversed");
  });

  it("should mark an ordinary completed payment settled", async () => {
    expect((await rows()).filter((r) => r.id === "TXN0001")[0]?.status).toBe("settled");
  });
});

describe("parsePayPalCsv — parsing", () => {
  it("should read every row", async () => {
    expect((await rows()).length).toBe(7);
  });

  it("should take the merchant name from the Name column", async () => {
    expect((await rows()).filter((r) => r.id === "TXN0001")[0]?.merchantKey).toBe("Netflix");
  });

  // This is the whole reason the CSV adapter exists. A consumer export is the
  // only PayPal surface that names the payee, so this is where the detector
  // graph gets a real merchant identity.
  it("should mark identity as coming from the export, not from the seed", async () => {
    expect((await rows())[0]?.identitySource).toBe("csv_payee");
  });

  it("should parse a name containing a comma", async () => {
    expect((await rows()).filter((r) => r.id === "TXN0006")[0]?.merchantKey).toBe(
      "O'Brien, Ltd",
    );
  });

  it("should keep the verbatim row, so a spike answer stays recoverable", async () => {
    expect((await rows())[0]?.raw).toMatchObject({
      Name: "Netflix",
      Type: "Recurring Payment",
    });
  });

  it("should carry the PayPal transaction type through as the subject", async () => {
    expect((await rows()).filter((r) => r.id === "TXN0001")[0]?.subject).toBe(
      "Recurring Payment",
    );
  });

  it("should skip a row with no transaction id", async () => {
    const broken = EXPORT.replace('"TXN0007"', '""');
    expect((await rows(broken)).length).toBe(6);
  });

  it("should skip a row with an unparseable amount, keeping the rest", async () => {
    const broken = EXPORT.replace('"-15.99","-1.32","-17.31","me@example.com","billing@netflix.com","TXN0001"',
      '"n/a","-1.32","-17.31","me@example.com","billing@netflix.com","TXN0001"');
    const parsed = await rows(broken);
    expect(parsed.length).toBe(6);
    expect(parsed.some((r) => r.id === "TXN0001")).toBe(false);
  });
});

describe("parsePayPalCsv — range filtering", () => {
  it("should return only transactions inside the range", async () => {
    const parsed = await createCsvAccountSource(EXPORT).listTransactions({
      start: new Date("2026-06-01T00:00:00.000Z"),
      end: new Date("2026-10-01T00:00:00.000Z"),
    });
    // 25 Jun, 25 Jul, 25 Aug (Netflix) · 2 Sep (Spotify) · 4 Jun (O'Brien).
    // 25 May and 6 Apr fall outside.
    expect(parsed.map((t) => t.id).sort()).toEqual([
      "TXN0002",
      "TXN0003",
      "TXN0004",
      "TXN0005",
      "TXN0006",
    ]);
  });

  it("should return everything for a wide range", async () => {
    expect((await rows()).length).toBe(7);
  });
});

describe("parsePayPalCsv — capabilities", () => {
  it("should claim only read access", async () => {
    expect(await createCsvAccountSource(EXPORT).capabilities()).toEqual({
      listTransactions: true,
      listSubscriptions: false,
      listDisputes: false,
      refund: false,
      cancelSubscription: false,
      resolveDispute: false,
    });
  });

  it("should throw a typed error rather than return an empty list for disputes", async () => {
    // "No disputes" and "cannot see disputes" are different answers, and
    // conflating them would let the demo imply a merchant dispute view.
    await expect(createCsvAccountSource(EXPORT).listDisputes()).rejects.toBeInstanceOf(
      UnsupportedCapabilityError,
    );
  });

  it("should name the capability and the adapter in the error", async () => {
    await expect(createCsvAccountSource(EXPORT).listSubscriptions()).rejects.toMatchObject({
      capability: expect.stringContaining("subscriptions"),
      adapter: "csv",
    });
  });
});

describe("parsePayPalCsv — feeding the core", () => {
  it("should produce a series the recurrence detector recognises as a subscription", async () => {
    const result = inferRecurrence(await rows());
    const netflix = result.find((r) => r.merchantKey === "Netflix");
    expect(netflix?.isRecurring).toBe(true);
    expect(netflix?.cadence).toBe("monthly");
    expect(netflix?.medianAmountCents).toBe(1_599);
  });

  it("should not invent a subscription out of a single charge", async () => {
    const result = inferRecurrence(await rows());
    expect(result.find((r) => r.merchantKey === "Spotify")?.isRecurring).toBe(false);
  });
});