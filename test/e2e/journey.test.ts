/**
 * The vertical slice, end to end.
 *
 * This is the demo's regression net, written before the demo exists. It runs
 * the whole journey through every real layer:
 *
 *   seed -> read back -> detect -> rank -> persist the run -> replay
 *
 * Nothing inside this repository is faked. The only substitute is SQLite for
 * D1 - the same dialect, foreign keys switched on - because Cloudflare is not
 * available on a machine with no account. Everything else is production code:
 * the same repository, the same KVStore port, the same lifted detector graph.
 *
 * As Phases 4-7 land this file grows the journey into
 * `seed -> agent -> proposal -> approval -> execution -> run log`. The point
 * of writing it now is that P8-06's cold rehearsal should find nothing, because
 * every commit already ran the journey.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { createSqliteD1 } from "../support/sqliteD1";
import { createDatabase, type Database } from "@/db";
import { createD1KvStore, type KVStore } from "@/db/kvStore";
import { insertSubscription, listSubscriptions } from "@/db/subscriptions";
import { appendRunStep, readRunSteps } from "@/db/runLog";
import { computeInsights, type Recommendation } from "@/core/insights";
import { recordUsage } from "@/core/unusedDetector";
import { recordPriceChange } from "@/core/priceHistory";
import { recordCancelIntent } from "@/core/cancelIntent";
import { readLedger, totalSavedMonthlyCents } from "@/core/savingsLedger";
import { getCancelGuide } from "@/core/cancelGuide";
import { monthlyTotal, formatMoney, type Currency } from "@/core";
import { SubscriptionSchema, type Subscription } from "@/core/validators";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const DAY = 86_400_000;

/** The demo clock. Fixed, so the whole journey is reproducible on any day. */
const NOW = new Date("2026-10-09T00:00:00.000Z");
const RUN_ID = "run-demo-1";

function freshDatabase(): Database {
  const sqlite = new BetterSqlite3(":memory:");
  const db = createDatabase(createSqliteD1(sqlite));
  sqlite.exec(readFileSync(path.join(REPO_ROOT, "src", "db", "schema.sql"), "utf8"));
  return db;
}

/**
 * The seeded scenario: a small merchant account with one obvious problem, one
 * ambiguous one, and one clean subscription so the run has to discriminate
 * rather than flag everything.
 */
function scenario(overrides: Partial<Subscription> = {}): Subscription {
  return SubscriptionSchema.parse({
    id: "sub-netflix",
    name: "Netflix",
    amountCents: 1_599,
    currency: "USD",
    billingCycle: "monthly",
    nextRenewal: new Date(NOW.getTime() + 3 * DAY).toISOString(),
    category: "entertainment",
    lastUsedDate: new Date(NOW.getTime() - 91 * DAY).toISOString(),
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  });
}

/** Run the whole slice and hand back everything it produced. */
async function runDemoJourney() {
  const db = freshDatabase();
  const store: KVStore = createD1KvStore(db);
  const steps: Array<{ seq: number; kind: string; label: string; payload?: unknown; durationMs?: number }> = [];
  let seq = 0;
  const record = async (
    kind: "llm_call" | "tool_call" | "tool_result" | "note",
    label: string,
    payload?: unknown,
    durationMs?: number,
  ): Promise<void> => {
    seq += 1;
    steps.push({ seq, kind, label, ...(payload === undefined ? {} : { payload }), ...(durationMs === undefined ? {} : { durationMs }) });
    await appendRunStep(db, { runId: RUN_ID, seq, kind, label, payload, durationMs }, () => NOW.toISOString());
  };

  // --- seed: real rows through the real repository -------------------------
  await record("note", "seed scenario", {
    subscriptions: ["sub-netflix", "sub-netflix-family", "sub-figma"],
  });

  await insertSubscription(db, scenario());
  await insertSubscription(db, scenario({ id: "sub-netflix-family", name: "Netflix Family" }));
  await insertSubscription(
    db,
    scenario({
      id: "sub-figma",
      name: "Figma",
      amountCents: 1_500,
      lastUsedDate: new Date(NOW.getTime() - 2 * DAY).toISOString(),
    }),
  );

  // --- the usage signal, recorded the way the agent will record it ---------
  await recordUsage(store, "sub-netflix", "2026-07-10T00:00:00.000Z");
  await recordPriceChange(store, "sub-figma", 1_200, { currency: "USD", now: NOW });
  await recordPriceChange(store, "sub-figma", 1_500, { currency: "USD", now: NOW });

  // --- read back through D1 ------------------------------------------------
  await record("tool_call", "list_subscriptions", { count: 3 });
  const subs = await listSubscriptions(db);
  await record("tool_result", "list_subscriptions", { returned: subs.length });

  // --- detect and rank -----------------------------------------------------
  await record("llm_call", "classify and rank", { model: "placeholder" }, 412);
  const recommendations = await computeInsights(store, subs, NOW);
  await record("tool_result", "compute_insights", { findings: recommendations.length });

  return { db, store, subs, recommendations, steps };
}

describe("e2e — the demo journey", () => {
  let db: Database;
  let store: KVStore;
  let subs: Subscription[];
  let recommendations: Recommendation[];

  beforeEach(async () => {
    ({ db, store, subs, recommendations } = await runDemoJourney());
  });

  it("should read back exactly what was seeded", () => {
    expect(subs.map((s) => s.id)).toEqual([
      "sub-figma",
      "sub-netflix",
      "sub-netflix-family",
    ]);
    expect(subs.every((s) => SubscriptionSchema.safeParse(s).success)).toBe(true);
  });

  it("should produce findings from the seeded account", () => {
    expect(recommendations.length).toBeGreaterThan(0);
    expect(recommendations.map((r) => r.kind)).toContain("duplicate");
  });

  it("should find the duplicate pair and leave the clean subscription alone", () => {
    const duplicate = recommendations.find((r) => r.kind === "duplicate");
    expect(duplicate).toBeDefined();
    // Attributed to the more expensive of the pair, deterministically.
    expect(["sub-netflix", "sub-netflix-family"]).toContain(duplicate?.subId);

    const figmaFindings = recommendations.filter((r) => r.subId === "sub-figma");
    expect(figmaFindings.some((f) => f.kind === "unused")).toBe(false);
  });

  it("should find the idle subscription renewing inside the window", () => {
    const unused = recommendations.filter((r) => r.kind === "unused");
    expect(unused.length).toBeGreaterThan(0);
    expect(unused.map((r) => r.subId)).toContain("sub-netflix-family");
  });

  // Both Netflix plans are idle and cost the same, so both unused detectors
  // tie at 1599 with the duplicate flag. `upsert` only replaces on a strictly
  // greater saving, and the duplicate is written first - so the expensive
  // plan keeps the duplicate finding (the stronger claim) and the other keeps
  // its own. Neither subscription silently loses its finding.
  it("should keep both Netflix findings rather than collapsing them", () => {
    const netflixFindings = recommendations.filter((r) =>
      ["sub-netflix", "sub-netflix-family"].includes(r.subId),
    );
    const bySub = new Map(netflixFindings.map((r) => [r.subId, r.kind]));

    expect(bySub.get("sub-netflix")).toBe("duplicate");
    expect(bySub.get("sub-netflix-family")).toBe("unused");
    expect(bySub.size).toBe(2);
  });

  it("should find the price hike on Figma", () => {
    const hike = recommendations.find((r) => r.kind === "priceHike");
    expect(hike?.subId).toBe("sub-figma");
    expect(hike?.savingCents).toBe(300);
    expect(hike?.title).toContain("$15");
  });

  it("should rank findings by the forward monthly saving, descending", () => {
    const savings = recommendations.map((r) => r.savingCents);
    expect(savings).toEqual([...savings].sort((a, b) => b - a));
  });

  it("should report a numeric confidence on every finding", () => {
    for (const rec of recommendations) {
      expect(typeof rec.confidence).toBe("number");
      expect(rec.confidence).toBeGreaterThanOrEqual(0);
      expect(rec.confidence).toBeLessThanOrEqual(1);
    }
  });

  // The claim ARCHITECTURE.md section 5 rests on: every figure on screen
  // traces to a pure function, never to the model.
  it("should reconcile every headline against a pure function, not the run log", () => {
    const netflix = subs.find((s) => s.id === "sub-netflix");
    expect(netflix).toBeDefined();
    if (netflix === undefined) return;

    const money = (cents: number, currency: Currency): string => formatMoney(cents, currency);

    // The ranking axis is exactly the monthly-normalised amount of the
    // subscription it points at.
    for (const rec of recommendations) {
      const target = subs.find((s) => s.id === rec.subId);
      if (target === undefined) continue;
      if (rec.kind === "duplicate" || rec.kind === "unused") {
        expect(rec.savingCents).toBeLessThanOrEqual(target.amountCents);
        expect(money(rec.savingCents, target.currency)).toMatch(/[$₹]/);
      }
    }

    // And the account total is monthlyTotal, not anything the run log said.
    expect(monthlyTotal(subs)).toBe(1_599 + 1_599 + 1_500);
  });

  it("should keep the ranking axis and the displayed headline as different figures", () => {
    const unused = recommendations.find((r) => r.kind === "unused");
    expect(unused?.savingCents).toBe(1_599);
    // 91 days idle => 3 months => $47.97. Collapse these two and the copy
    // and the comparison both break.
    expect(unused?.displaySaving).toContain("$47.97");
  });

  it("should resolve a cancel guide for every merchant it found", () => {
    for (const sub of subs) {
      const guide = getCancelGuide(sub.name);
      expect(guide.steps.length).toBeGreaterThan(0);
    }
    expect(getCancelGuide("Netflix").key).toBe("netflix");
  });

  it("should record an intent without moving money, and total the saving", async () => {
    const netflix = subs.find((s) => s.id === "sub-netflix");
    expect(netflix).toBeDefined();
    if (netflix === undefined) return;

    const result = await recordCancelIntent(store, netflix);
    expect(result.nextTotalCents).toBe(1_599);
    expect(totalSavedMonthlyCents(await readLedger(store))).toBe(1_599);
  });

  it("should replay the run in the order it happened", async () => {
    const replayed = await readRunSteps(db, RUN_ID);
    expect(replayed.map((s) => s.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(replayed.map((s) => s.label)).toEqual([
      "seed scenario",
      "list_subscriptions",
      "list_subscriptions",
      "classify and rank",
      "compute_insights",
    ]);
  });

  it("should preserve the payload of every step, so the timeline can show the reasoning", async () => {
    const replayed = await readRunSteps(db, RUN_ID);
    const classify = replayed.find((s) => s.label === "classify and rank");
    expect(classify?.payload).toEqual({ model: "placeholder" });
    expect(classify?.durationMs).toBe(412);

    const findings = replayed.find((s) => s.payload && "findings" in (s.payload as object));
    expect(findings?.payload).toMatchObject({ findings: recommendations.length });
  });

  it("should produce the same journey every time it runs", async () => {
    const again = await runDemoJourney();
    expect(again.recommendations).toEqual(recommendations);
    expect(await readRunSteps(again.db, RUN_ID)).toEqual(await readRunSteps(db, RUN_ID));
  });
});