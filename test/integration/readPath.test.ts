import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { createSqliteD1 } from "../support/sqliteD1";
import { createDatabase, type Database } from "@/db";
import { listTransactions } from "@/db/transactions";
import { insertSubscription, listSubscriptions } from "@/db/subscriptions";
import { createMemoryKvStore } from "@/db/memoryKvStore";
import { recordUsage } from "@/core/unusedDetector";
import { seedHistory, reseedHistory, SCENARIO } from "@/services/seedHistory";
import { buildSubscriptions } from "@/core/subscriptions";
import { inferRecurrence } from "@/core/recurrence";
import { computeInsights } from "@/core/insights";
import { seedMarker } from "@/adapters/seedMarker";

/**
 * The whole read path, end to end, against real SQL.
 *
 *   history -> transactions -> recurrence -> subscriptions -> insights -> a figure
 *
 * This is the test that makes step 1's gate mean something. Every previous test
 * in this area hands `computeInsights` subscription rows that someone typed; the
 * first screen of the demo cannot do that, so this file is where the chain gets
 * proven from rows that came out of the other end.
 */

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const NOW = new Date("2026-10-17T00:00:00.000Z");

let db: Database;

beforeEach(() => {
  const sqlite = new BetterSqlite3(":memory:");
  db = createDatabase(createSqliteD1(sqlite));
  sqlite.exec(readFileSync(path.join(REPO_ROOT, "src", "db", "schema.sql"), "utf8"));
});

describe("seeded history", () => {
  it("writes one row per charge", async () => {
    const { rows } = await seedHistory(db, { now: NOW });
    const expected = SCENARIO.reduce((sum, s) => sum + s.charges, 0);
    expect(rows).toBe(expected);
    expect(await listTransactions(db)).toHaveLength(expected);
  });

  it("marks every row as ours, because the detector's trust depends on it", async () => {
    // This is the whole reason the middle lane is defensible. Every row carries
    // the `spendless:` marker, so it resolves to `seed_marker` rather than to
    // "unknown", and the UI has something concrete to label it with.
    await seedHistory(db, { now: NOW });
    const stored = await listTransactions(db);

    expect(stored.length).toBeGreaterThan(0);
    for (const tx of stored) {
      expect(tx.customId).toBe(seedMarker(tx.merchantName));
    }
  });

  it("spreads charges across months, which is the entire reason it exists", async () => {
    await seedHistory(db, { now: NOW });
    const stored = await listTransactions(db);
    const dates = stored.map((t) => Date.parse(t.capturedAt)).sort((a, b) => a - b);

    const spanDays = (dates[dates.length - 1]! - dates[0]!) / 86_400_000;
    expect(spanDays).toBeGreaterThan(180);
  });

  it("produces a stable scenario for a fixed clock", async () => {
    // A history that moves with the wall clock makes the demo's figures differ
    // every run, which is the opposite of what a recorded video needs.
    await seedHistory(db, { now: NOW });
    const first = await listTransactions(db);

    await reseedHistory(db, { now: NOW });
    const second = await listTransactions(db);

    expect(second).toEqual(first);
  });

  it("replaces rather than accumulates on a reseed", async () => {
    await seedHistory(db, { now: NOW });
    const after = await reseedHistory(db, { now: NOW });
    expect(after.rows).toBe(SCENARIO.reduce((s, x) => s + x.charges, 0));
  });

  it("gives one subscription a price hike the recurrence detector must not claim", async () => {
    await seedHistory(db, { now: NOW });
    const stored = await listTransactions(db);
    const adobe = stored.filter((t) => t.merchantName === "sub-adobe");
    const amounts = [...new Set(adobe.map((t) => t.amountCents))];

    // Two distinct amounts on one merchant. If recurrence inference happily
    // called this a subscription, both detectors would report the same
    // subscription and the figure would be counted twice.
    expect(amounts.length).toBe(2);
  });
});

describe("the whole chain, from stored rows to a figure", () => {
  it("produces a money-at-risk figure without anyone typing a row", async () => {
    await seedHistory(db, { now: NOW });

    // history -> recurrence
    const stored = await listTransactions(db);
    const recurrences = inferRecurrence(
      stored.map((t) => ({
        merchantKey: t.merchantName,
        // Derived, not asserted: a row is ours because its custom_id carries the
        // marker. Same rule the adapter uses.
        identitySource: t.customId?.startsWith("spendless:") === true ? "seed_marker" : "unknown",
        amountCents: t.amountCents,
        currencyCode: t.currency,
        capturedAt: t.capturedAt,
      })),
    );

    // recurrence -> subscriptions -> rows
    const subs = buildSubscriptions(recurrences, { now: NOW, currency: "USD" });
    expect(subs.length).toBeGreaterThan(0);
    for (const sub of subs) await insertSubscription(db, sub);

    const persisted = await listSubscriptions(db);
    expect(persisted.length).toBe(subs.length);

    // subscriptions -> insights -> the figure on the first screen
    const kv = createMemoryKvStore();

    /**
     * Nothing, before anyone says anything.
     *
     * `ARCHITECTURE.md` §8: transaction history contains no usage signal. So
     * with no usage recorded, no "unused" finding may exist — the detectors are
     * not permitted to infer idleness from the absence of data, which is the
     * single easiest way for this product to fabricate money at risk. This
     * assertion is that rule, enforced rather than documented.
     */
    const beforeUsage = await computeInsights(kv, persisted, NOW);
    expect(beforeUsage.filter((f) => f.kind === "unused")).toEqual([]);

    // `costPerUseFlags` only fires once `lastUsedDate` is older than the idle
    // threshold, and this product has no usage signal (ARCHITECTURE.md §8) -
    // so the human supplies it. That is the designed path, not a workaround.
    const netflix = persisted.find((s) => s.id === "sub-netflix");
    expect(netflix).toBeDefined();
    if (netflix === undefined) return;
    await recordUsage(kv, netflix.id, new Date(NOW.getTime() - 91 * 86_400_000).toISOString());

    const withUsage = await computeInsights(kv, persisted, NOW);
    const idle = withUsage.find((f) => f.subId === "sub-netflix" && f.kind === "unused");

    expect(idle).toBeDefined();
    // The gate: the hero figure IS this number, not a restatement of it.
    expect(idle?.savingCents).toBe(1_599);
  });

  it("reports nothing at risk when nothing has been seeded", async () => {
    // The empty state is a real state the UI has to render, and it must be an
    // honest zero rather than a screen that looks broken.
    const findings = await computeInsights(createMemoryKvStore(), [], NOW);
    expect(findings).toEqual([]);
  });
});