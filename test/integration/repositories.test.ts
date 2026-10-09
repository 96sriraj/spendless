import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { createSqliteD1 } from "../support/sqliteD1";
import { createDatabase, type Database } from "@/db";
import { createD1KvStore, type KVStore } from "@/db/kvStore";
import { insertSubscription, listSubscriptions } from "@/db/subscriptions";
import { appendRunStep, nextSeq, readRunSteps, RUN_STEP_KINDS } from "@/db/runLog";
import type { Subscription } from "@/core/validators";
import { SubscriptionSchema } from "@/core/validators";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");

function freshDatabase(): Database {
  const sqlite = new BetterSqlite3(":memory:");
  const db = createDatabase(createSqliteD1(sqlite));
  sqlite.exec(readFileSync(path.join(REPO_ROOT, "src", "db", "schema.sql"), "utf8"));
  return db;
}

function sub(overrides: Partial<Subscription> = {}): Subscription {
  return {
    id: "sub-1",
    name: "Netflix",
    amountCents: 1_599,
    currency: "USD",
    billingCycle: "monthly",
    nextRenewal: "2026-11-01T00:00:00.000Z",
    category: "entertainment",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("subscriptions repository", () => {
  let db: Database;
  beforeEach(() => {
    db = freshDatabase();
  });

  it("should round-trip a subscription through real SQL", async () => {
    await insertSubscription(db, sub());
    const [read] = await listSubscriptions(db);

    expect(read).toMatchObject(sub());
    // Absent optionals come back as explicit nulls, which is what zod yields
    // for a row and what the detector graph reads. Asserted rather than papered
    // over: a key that is absent and a key that is null behave differently
    // once this object crosses into React.
    expect(read?.trialEndDate).toBeNull();
    expect(read?.lastUsedDate).toBeNull();
    expect(read?.annualAmountCents).toBeNull();
    expect(SubscriptionSchema.safeParse(read).success).toBe(true);
  });

  it("should round-trip every optional field", async () => {
    const full = sub({
      trialEndDate: "2026-10-20T00:00:00.000Z",
      lastUsedDate: "2026-09-01T00:00:00.000Z",
      annualAmountCents: 14_399,
      notes: "family plan",
    });
    await insertSubscription(db, full);
    const [read] = await listSubscriptions(db);
    expect(read).toEqual(SubscriptionSchema.parse(full));
  });

  it("should return rows in a stable order regardless of insertion order", async () => {
    await insertSubscription(db, sub({ id: "sub-c" }));
    await insertSubscription(db, sub({ id: "sub-a" }));
    await insertSubscription(db, sub({ id: "sub-b" }));

    const first = await listSubscriptions(db);
    const second = await listSubscriptions(db);
    expect(first.map((s) => s.id)).toEqual(["sub-a", "sub-b", "sub-c"]);
    expect(second).toEqual(first);
  });

  it("should skip a malformed row rather than fail the whole read", async () => {
    await insertSubscription(db, sub({ id: "good" }));
    // SQLite enforces the CHECK constraints but has no opinion about string
    // length, so an over-long name reaches the zod boundary intact. That
    // boundary is the only thing standing between a bad PayPal payload and a
    // broken detector, so it gets a test.
    await db.run(
      `INSERT INTO subscriptions (id, name, amount_cents, currency, billing_cycle, next_renewal, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      "broken",
      "A".repeat(200),
      1000,
      "USD",
      "monthly",
      "2026-11-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
    );
    expect((await listSubscriptions(db)).map((s) => s.id)).toEqual(["good"]);
  });

  it("should refuse to insert the same subscription twice", async () => {
    await insertSubscription(db, sub());
    await expect(insertSubscription(db, sub())).rejects.toThrow();
  });

  it("should return nothing for an empty table", async () => {
    expect(await listSubscriptions(db)).toEqual([]);
  });
});

describe("run log", () => {
  let db: Database;
  beforeEach(() => {
    db = freshDatabase();
  });

  it("should hand out sequence numbers in order", async () => {
    expect(await nextSeq(db, "run-1")).toBe(1);
    await appendRunStep(db, { runId: "run-1", seq: 1, kind: "note", label: "a" });
    expect(await nextSeq(db, "run-1")).toBe(2);
  });

  it("should replay a run in the order it was written, not the order it landed", async () => {
    await appendRunStep(db, { runId: "run-1", seq: 3, kind: "note", label: "third" });
    await appendRunStep(db, { runId: "run-1", seq: 1, kind: "note", label: "first" });
    await appendRunStep(db, { runId: "run-1", seq: 2, kind: "note", label: "second" });

    expect((await readRunSteps(db, "run-1")).map((s) => s.label)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });

  it("should refuse a duplicate sequence number within a run", async () => {
    await appendRunStep(db, { runId: "run-1", seq: 1, kind: "note", label: "a" });
    await expect(
      appendRunStep(db, { runId: "run-1", seq: 1, kind: "note", label: "b" }),
    ).rejects.toThrow();
  });

  it("should keep separate runs separate", async () => {
    await appendRunStep(db, { runId: "run-1", seq: 1, kind: "note", label: "a" });
    await appendRunStep(db, { runId: "run-2", seq: 1, kind: "note", label: "b" });
    expect(await readRunSteps(db, "run-1")).toHaveLength(1);
    expect((await readRunSteps(db, "run-2"))[0]?.label).toBe("b");
  });

  it("should return an empty timeline for a run that never happened", async () => {
    expect(await readRunSteps(db, "nope")).toEqual([]);
  });

  it("should keep a payload and a duration, because the timeline has to show the reasoning", async () => {
    await appendRunStep(db, {
      runId: "run-1",
      seq: 1,
      kind: "llm_call",
      label: "classify merchants",
      payload: { model: "cheap-instruct", tokens: 412 },
      durationMs: 830,
    });
    const [step] = await readRunSteps(db, "run-1");
    expect(step?.payload).toEqual({ model: "cheap-instruct", tokens: 412 });
    expect(step?.durationMs).toBe(830);
  });

  it("should refuse a step kind the run log does not define", async () => {
    await expect(
      appendRunStep(db, {
        runId: "run-1",
        seq: 1,
        kind: "shout" as (typeof RUN_STEP_KINDS)[number],
        label: "x",
      }),
    ).rejects.toThrow();
  });
});

describe("D1 KVStore against real SQL, through the lifted modules' port", () => {
  it("should behave the same as the in-memory store for the whole graph", async () => {
    const db = freshDatabase();
    const store: KVStore = createD1KvStore(db);
    const key = "priceHistory:sub-1";

    expect(await store.kvGet(key)).toBeNull();
    await store.kvSet(key, '[]');
    expect(await store.kvGet(key)).toBe('[]');
    await store.kvSet(key, '[{"amountCents":1}]');
    expect(await store.kvGet(key)).toBe('[{"amountCents":1}]');
    await store.kvRemove(key);
    expect(await store.kvGet(key)).toBeNull();
  });
});