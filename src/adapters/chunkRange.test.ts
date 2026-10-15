import { describe, expect, it } from "vitest";
import { chunkRange, mergeTransactions, PAYPAL_MAX_WINDOW_DAYS } from "./chunkRange";
import type { RawTransaction } from "./AccountSource";

const DAY = 86_400_000;
const START = Date.parse("2026-01-01T00:00:00.000Z");
const END = Date.parse("2026-12-31T00:00:00.000Z");

const range = (start: number, end: number) => ({
  start: new Date(start),
  end: new Date(end),
});

describe("chunkRange — the 31-day cap", () => {
  it("should state the cap it is enforcing", () => {
    // 31 is PayPal's documented maximum window for transaction search, and the
    // MCP wrapper additionally clamps client-side. Both are silent: a caller
    // asking for a year gets a month and no error.
    expect(PAYPAL_MAX_WINDOW_DAYS).toBe(31);
  });

  it("should return a single chunk for a range inside the cap", () => {
    const chunks = chunkRange(range(START, START + 10 * DAY));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.start.getTime()).toBe(START);
    expect(chunks[0]?.end.getTime()).toBe(START + 10 * DAY);
  });

  it("should return a single chunk for exactly the cap", () => {
    expect(chunkRange(range(START, START + 31 * DAY))).toHaveLength(1);
  });

  it("should split a longer range rather than silently truncating it", () => {
    const chunks = chunkRange(range(START, END));
    expect(chunks.length).toBeGreaterThan(1);
  });

  // The property that actually matters: no transaction may fall between two
  // chunks. A gap of one millisecond would silently lose a charge.
  it("should produce contiguous chunks with no gap between them", () => {
    const chunks = chunkRange(range(START, END));
    for (let i = 1; i < chunks.length; i += 1) {
      const previous = chunks[i - 1];
      const current = chunks[i];
      if (previous === undefined || current === undefined) continue;
      expect(current.start.getTime()).toBe(previous.end.getTime());
    }
  });

  it("should cover the whole requested range, first start to last end", () => {
    const chunks = chunkRange(range(START, END));
    const first = chunks[0];
    const last = chunks[chunks.length - 1];
    expect(first?.start.getTime()).toBe(START);
    expect(last?.end.getTime()).toBe(END);
  });

  it("should never emit a chunk wider than the cap", () => {
    for (const chunk of chunkRange(range(START, END))) {
      const days = (chunk.end.getTime() - chunk.start.getTime()) / DAY;
      expect(days).toBeLessThanOrEqual(PAYPAL_MAX_WINDOW_DAYS);
    }
  });

  it("should handle a two-year range without an unbounded loop", () => {
    const chunks = chunkRange(range(START, START + 730 * DAY));
    expect(chunks.length).toBeGreaterThan(20);
    expect(chunks.length).toBeLessThan(30);
  });

  it("should return an empty list for an inverted range", () => {
    expect(chunkRange(range(END, START))).toEqual([]);
  });

  it("should return an empty list for a zero-width range", () => {
    expect(chunkRange(range(START, START))).toEqual([]);
  });

  it("should not loop forever on a zero or negative cap", () => {
    expect(chunkRange(range(START, END), 0)).toEqual([]);
  });

  it("should accept a caller-supplied smaller cap", () => {
    const chunks = chunkRange(range(START, START + 10 * DAY), 5);
    expect(chunks).toHaveLength(2);
  });
});

describe("mergeTransactions — boundary dedup", () => {
  const t = (id: string, capturedAt: string): RawTransaction => ({
    id,
    merchantKey: "sub-netflix",
    identitySource: "seed_invoice_id",
    amountCents: 1_599,
    currencyCode: "USD",
    capturedAt,
    eventCode: "T0001",
    status: "settled",
    subject: null,
    raw: {},
  });

  // Chunks share a boundary instant, so a charge landing exactly on one can come
  // back twice. Two rows for one charge would inflate the series and could
  // manufacture a cadence.
  it("should collapse the same transaction returned by two chunks", () => {
    const at = "2026-02-01T00:00:00.000Z";
    const chunks = chunkRange(range(START, END));
    const batches = chunks.map(() => [t("TXN1", at)]);

    expect(mergeTransactions(batches)).toHaveLength(1);
  });

  it("should keep genuinely different transactions across chunks", () => {
    const merged = mergeTransactions([
      [t("TXN1", "2026-02-01T00:00:00.000Z")],
      [t("TXN2", "2026-02-02T00:00:00.000Z"), t("TXN3", "2026-02-03T00:00:00.000Z")],
    ]);
    expect(merged.map((x) => x.id)).toEqual(["TXN1", "TXN2", "TXN3"]);
  });

  it("should keep the first occurrence and not reorder the rest", () => {
    const merged = mergeTransactions([
      [t("TXN1", "2026-02-01T00:00:00.000Z"), t("TXN2", "2026-02-02T00:00:00.000Z")],
      [t("TXN1", "2026-02-01T00:00:00.000Z")],
    ]);
    expect(merged.map((x) => x.id)).toEqual(["TXN1", "TXN2"]);
  });

  it("should return an empty list for no transactions", () => {
    expect(mergeTransactions([])).toEqual([]);
    expect(mergeTransactions([[], []])).toEqual([]);
  });
});