import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { createSqliteD1 } from "../support/sqliteD1";
import { createDatabase, type Database } from "@/db";
import { listTransactions } from "@/db/transactions";
import { insertSubscription, listSubscriptions, upsertSubscription } from "@/db/subscriptions";
import { createMemoryKvStore } from "@/db/memoryKvStore";
import { createD1KvStore } from "@/db/kvStore";
import { recordUsage } from "@/core/unusedDetector";
import { seedHistory, reseedHistory, SCENARIO } from "@/services/seedHistory";
import { buildSubscriptions } from "@/core/subscriptions";
import { inferRecurrence } from "@/core/recurrence";
import { computeInsights } from "@/core/insights";
import { SubscriptionSchema } from "@/core/validators";
import { seedMarker } from "@/adapters/seedMarker";
import { buildReadModel } from "@/services/readModel";

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

/**
 * `buildReadModel` is what `/api/state` answers from, so these are the API's
 * contract tests: the shape the first screen is coded against, and the guarantees
 * that keep the number on it honest.
 */
describe("the read model behind /api/state", () => {
  it("derives subscriptions from stored rows, so no test data reaches the screen", async () => {
    // The whole point of step 1. The previous behaviour was a hardcoded
    // `PLACEHOLDER_RISK_CENTS = 4_797` in the client, which is a figure no
    // function computed and no test could check.
    await seedHistory(db, { now: NOW });
    const model = await buildReadModel(db, NOW);

    expect(model.subscriptions.length).toBeGreaterThan(0);
    expect(model.transactionCount).toBe(SCENARIO.reduce((s, x) => s + x.charges, 0));
  });

  it("totals the figure from the findings, so the hero number is a sum of rows", async () => {
    // Not restated, not rounded, not clamped. `savingCents` is the ranking axis
    // and summing it is the only honest total - `displaySaving` is a formatted
    // string for cards and would be nonsense to add up.
    await seedHistory(db, { now: NOW });
    const model = await buildReadModel(db, NOW);

    const summed = model.findings.reduce((sum, f) => sum + f.savingCents, 0);
    expect(model.totalRiskCents).toBe(summed);
  });

  it("is zero, not null, when there is nothing to report", async () => {
    const model = await buildReadModel(db, NOW);

    expect(model.totalRiskCents).toBe(0);
    expect(model.findings).toEqual([]);
    expect(model.subscriptions).toEqual([]);
  });

  it("labels every finding with the lane its data came from", async () => {
    // D5, and the rule that keeps the product honest: history is ours, it is not
    // a payment, and a figure derived from it must never be rendered as though
    // PayPal reported it. A finding with no lane is undisplayable.
    await seedHistory(db, { now: NOW });
    const model = await buildReadModel(db, NOW);

    for (const finding of model.findings) {
      expect(finding.lane).toBe("seeded_history");
    }
  });

  it("names the lanes that contributed, so an empty screen can explain itself", async () => {
    await seedHistory(db, { now: NOW });
    const seeded = await buildReadModel(db, NOW);
    expect(seeded.lanes).toEqual(["seeded_history"]);

    const bare = await buildReadModel(createEmptyDb(), NOW);
    expect(bare.lanes).toEqual([]);
  });

  it("stamps when it ran, because a figure with no timestamp is not evidence", async () => {
    await seedHistory(db, { now: NOW });
    const model = await buildReadModel(db, NOW);

    expect(model.generatedAt).toBe(NOW.toISOString());
  });

  it("is stable for a fixed clock, so a recorded demo does not drift", async () => {
    await seedHistory(db, { now: NOW });
    const first = await buildReadModel(db, NOW);
    const second = await buildReadModel(db, NOW);

    expect(second.totalRiskCents).toBe(first.totalRiskCents);
    expect(second.findings.map((f) => f.subId)).toEqual(first.findings.map((f) => f.subId));
  });

  it("carries the usage signal through, so the designed finding is reachable", async () => {
    // The end-to-end version of the chain test above, through the service the
    // API actually calls. Without a recorded usage the screen is empty - and
    // that is correct (§8), so the signal has to be in the store beforehand.
    await seedHistory(db, { now: NOW });
    await recordUsage(createD1KvStore(db), "sub-netflix", "2026-07-18T00:00:00.000Z");

    const model = await buildReadModel(db, NOW);

    expect(model.findings.map((f) => f.subId)).toContain("sub-netflix");
    expect(model.totalRiskCents).toBeGreaterThan(0);
  });
});

function createEmptyDb(): Database {
  const sqlite = new BetterSqlite3(":memory:");
  const fresh = createDatabase(createSqliteD1(sqlite));
  sqlite.exec(readFileSync(path.join(REPO_ROOT, "src", "db", "schema.sql"), "utf8"));
  return fresh;
}

describe("reconciling subscriptions", () => {
  /**
   * The field that must survive a re-derive.
   *
   * `buildSubscriptions` writes `lastUsedDate: null` unconditionally — correctly,
   * since no usage signal exists in transaction data. So any reconciliation pass
   * that overwrites that column with the derived `null` erases the only usage
   * data anyone ever supplied, and the product's headline finding quietly stops
   * appearing while the screen still looks correct.
   */
  it("preserves a recorded usage date when the derived row says null", async () => {
    const sqlite = new BetterSqlite3(":memory:");
    const store = createDatabase(createSqliteD1(sqlite));
    sqlite.exec(readFileSync(path.join(REPO_ROOT, "src", "db", "schema.sql"), "utf8"));

    const original = SubscriptionSchema.parse({
      id: "sub-netflix",
      name: "Netflix",
      amountCents: 1_599,
      currency: "USD",
      billingCycle: "monthly",
      nextRenewal: "2026-11-01T00:00:00.000Z",
      category: "other",
      lastUsedDate: "2026-07-18T00:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    await insertSubscription(store, original);

    // What `buildSubscriptions` would produce for the same merchant: same
    // identity and amount, but no usage date, because it has no way to know one.
    const derived = SubscriptionSchema.parse({
      ...original,
      lastUsedDate: null,
      nextRenewal: "2026-10-22T00:00:00.000Z",
      updatedAt: "2026-10-17T00:00:00.000Z",
    });
    await upsertSubscription(store, derived);

    const [stored] = await listSubscriptions(store);
    expect(stored?.lastUsedDate).toBe("2026-07-18T00:00:00.000Z");
    // The derived column did move, or the upsert is not doing its job at all.
    expect(stored?.nextRenewal).toBe("2026-10-22T00:00:00.000Z");
  });

  it("is safe to call repeatedly, because the UI polls /api/state", async () => {
    const sqlite = new BetterSqlite3(":memory:");
    const store = createDatabase(createSqliteD1(sqlite));
    sqlite.exec(readFileSync(path.join(REPO_ROOT, "src", "db", "schema.sql"), "utf8"));

    const sub = SubscriptionSchema.parse({
      id: "sub-a",
      name: "sub-a",
      amountCents: 500,
      currency: "USD",
      billingCycle: "monthly",
      nextRenewal: "2026-11-01T00:00:00.000Z",
      category: "other",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    await upsertSubscription(store, sub);
    await upsertSubscription(store, sub);
    await upsertSubscription(store, sub);

    expect(await listSubscriptions(store)).toHaveLength(1);
  });
});