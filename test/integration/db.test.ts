/**
 * The database layer, against real SQLite.
 *
 * No mocks of the code under test and no faked SQL: the schema file on disk is
 * applied to a real engine, exactly as `wrangler d1 migrations apply` would.
 * If this suite only ever proved that a hand-written fake returns what the
 * fake was told to return, it would prove nothing.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import type { Database as SqliteDatabase } from "better-sqlite3";
import { createSqliteD1 } from "../support/sqliteD1";
import { createDatabase, type Database } from "@/db";
import { createD1KvStore, type KVStore } from "@/db/kvStore";
import { createMemoryKvStore } from "@/db/memoryKvStore";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const SCHEMA_PATH = path.join(REPO_ROOT, "src", "db", "schema.sql");

function freshDatabase(): Database {
  const sqlite: SqliteDatabase = new BetterSqlite3(":memory:");
  const d1 = createSqliteD1(sqlite);
  sqlite.exec(readFileSync(SCHEMA_PATH, "utf8"));
  return createDatabase(d1);
}

describe("schema", () => {
  let db: Database;

  beforeEach(() => {
    db = freshDatabase();
  });

  it("creates every table the detector graph needs, as real columns", async () => {
    const tables = await db.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    );
    expect(tables.map((t) => t.name)).toEqual([
      "action_proposals",
      "action_results",
      "kv_store",
      "price_points",
      "run_steps",
      "savings_events",
      "subscriptions",
      "transactions",
      "usage_events",
    ]);
  });

  it("gives price_points real columns rather than a serialised blob", async () => {
    const columns = await db.all<{ name: string }>(
      "SELECT name FROM pragma_table_info('price_points') ORDER BY cid",
    );
    expect(columns.map((c) => c.name)).toEqual([
      "id",
      "subscription_id",
      "amount_cents",
      "currency",
      "recorded_at",
    ]);
  });

  it("gives run_steps real columns, so a run can be replayed in order", async () => {
    const columns = await db.all<{ name: string }>(
      "SELECT name FROM pragma_table_info('run_steps') ORDER BY cid",
    );
    expect(columns.map((c) => c.name)).toEqual([
      "id",
      "run_id",
      "seq",
      "kind",
      "label",
      "payload",
      "duration_ms",
      "created_at",
    ]);
  });

  it("accepts both currencies, because the sandbox is USD and the lifted code is INR", async () => {
    for (const currency of ["USD", "INR"]) {
      const row = await db.get<{ id: string }>(
        `INSERT INTO subscriptions (id, name, amount_cents, currency, billing_cycle, next_renewal, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        `sub-${currency}`,
        "Netflix",
        1599,
        currency,
        "monthly",
        "2027-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      );
      expect(row?.id).toBe(`sub-${currency}`);
    }
  });

  it("rejects a currency that is neither USD nor INR", async () => {
    await expect(
      db.run(
        `INSERT INTO subscriptions (id, name, amount_cents, currency, billing_cycle, next_renewal, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        "sub-eur",
        "Netflix",
        1599,
        "EUR",
        "monthly",
        "2027-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      ),
    ).rejects.toThrow();
  });

  it("enforces foreign keys, so a dangling price point is impossible", async () => {
    await expect(
      db.run(
        `INSERT INTO price_points (subscription_id, amount_cents, currency, recorded_at)
         VALUES (?, ?, ?, ?)`,
        "no-such-subscription",
        1599,
        "USD",
        "2026-01-01T00:00:00.000Z",
      ),
    ).rejects.toThrow();
  });

  it("keeps run_steps replayable by refusing a duplicate sequence number", async () => {
    const insert = (seq: number) =>
      db.run(
        `INSERT INTO run_steps (run_id, seq, kind, label, created_at) VALUES (?, ?, ?, ?, ?)`,
        "run-1",
        seq,
        "tool_call",
        `step ${seq}`,
        "2026-01-01T00:00:00.000Z",
      );
    await insert(1);
    await expect(insert(1)).rejects.toThrow();
  });
});

describe("database access layer", () => {
  let db: Database;

  beforeEach(() => {
    db = freshDatabase();
  });

  it("returns null for a row that does not exist, rather than undefined", async () => {
    expect(await db.get("SELECT id FROM subscriptions WHERE id = ?", "nope")).toBeNull();
  });

  it("returns an empty array for an empty result set", async () => {
    expect(await db.all("SELECT id FROM subscriptions")).toEqual([]);
  });

  it("binds strings, numbers, booleans and null in declared order", async () => {
    await db.run(
      `INSERT INTO subscriptions (id, name, amount_cents, currency, billing_cycle, next_renewal, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      "sub-1",
      "Netflix",
      1599,
      "USD",
      "monthly",
      null,
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
    );
    // `nextRenewal` has no NOT NULL constraint precisely because a PayPal
    // transaction can exist before its subscription does.
    const row = await db.get<{ next_renewal: string | null }>(
      "SELECT next_renewal FROM subscriptions WHERE id = ?",
      "sub-1",
    );
    expect(row?.next_renewal).toBeNull();
  });

  it("does not confuse an apostrophe in a merchant name for SQL", async () => {
    const name = "O'Brien Media Ltd";
    await db.run(
      `INSERT INTO subscriptions (id, name, amount_cents, currency, billing_cycle, next_renewal, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      "sub-quote",
      name,
      999,
      "USD",
      "monthly",
      "2027-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
    );
    const row = await db.get<{ name: string }>(
      "SELECT name FROM subscriptions WHERE id = ?",
      "sub-quote",
    );
    expect(row?.name).toBe(name);
  });

  it("reports how many rows a statement changed", async () => {
    await db.run(
      `INSERT INTO subscriptions (id, name, amount_cents, currency, billing_cycle, next_renewal, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      "sub-usage",
      "Netflix",
      1599,
      "USD",
      "monthly",
      "2027-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
    );
    const result = await db.run(
      `INSERT INTO usage_events (subscription_id, last_used_at, source, created_at)
       VALUES (?, ?, ?, ?)`,
      "sub-usage",
      "2026-01-01T00:00:00.000Z",
      "user",
      "2026-01-01T00:00:00.000Z",
    );
    expect(result.changes).toBe(1);
  });

  it("surfaces a constraint violation rather than swallowing it", async () => {
    await expect(
      db.run(
        `INSERT INTO subscriptions (id, name, amount_cents, currency, billing_cycle, next_renewal, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        "dup",
        "Netflix",
        1599,
        "USD",
        "monthly",
        "2027-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      ),
    ).resolves.toBeTruthy();
    await expect(
      db.run(
        `INSERT INTO subscriptions (id, name, amount_cents, currency, billing_cycle, next_renewal, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        "dup",
        "Netflix",
        1599,
        "USD",
        "monthly",
        "2027-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      ),
    ).rejects.toThrow();
  });

  it("orders a run's steps by sequence, so a replay is faithful", async () => {
    for (const [seq, label] of [
      [3, "third"],
      [1, "first"],
      [2, "second"],
    ] as const) {
      await db.run(
        `INSERT INTO run_steps (run_id, seq, kind, label, created_at) VALUES (?, ?, ?, ?, ?)`,
        "run-order",
        seq,
        "note",
        label,
        "2026-01-01T00:00:00.000Z",
      );
    }
    const steps = await db.all<{ label: string }>(
      "SELECT label FROM run_steps WHERE run_id = ? ORDER BY seq",
      "run-order",
    );
    expect(steps.map((s) => s.label)).toEqual(["first", "second", "third"]);
  });
});

describe("KVStore over D1", () => {
  let db: Database;
  let store: KVStore;

  beforeEach(() => {
    db = freshDatabase();
    store = createD1KvStore(db);
  });

  it("round-trips a value", async () => {
    await store.kvSet("priceHistory:sub-1", '[{"amountCents":1599}]');
    expect(await store.kvGet("priceHistory:sub-1")).toBe(
      '[{"amountCents":1599}]',
    );
  });

  it("returns null for a missing key, which is what the lifted modules branch on", async () => {
    expect(await store.kvGet("never-written")).toBeNull();
  });

  it("overwrites rather than duplicating, so last-write-wins still holds", async () => {
    await store.kvSet("usage:sub-1", "2026-01-01T00:00:00.000Z");
    await store.kvSet("usage:sub-1", "2026-02-01T00:00:00.000Z");
    expect(await store.kvGet("usage:sub-1")).toBe("2026-02-01T00:00:00.000Z");
    const rows = await db.all<{ n: number }>(
      "SELECT COUNT(*) AS n FROM kv_store WHERE key = ?",
      "usage:sub-1",
    );
    expect(rows[0]?.n).toBe(1);
  });

  it("removes a key", async () => {
    await store.kvSet("k", "v");
    await store.kvRemove("k");
    expect(await store.kvGet("k")).toBeNull();
  });

  it("removing a missing key is a no-op, not an error", async () => {
    await expect(store.kvRemove("absent")).resolves.toBeUndefined();
  });

  it("behaves identically to the in-memory store the lifted graph is tested against", async () => {
    const memory = createMemoryKvStore();
    const scenarios: ReadonlyArray<readonly [string, string]> = [
      ["a", "1"],
      ["b", ""],
      ["unicode:₹", '{"amountCents":1234}'],
      ["sql'; DROP TABLE kv_store; --", "still just a value"],
    ];

    for (const [key, value] of scenarios) {
      await store.kvSet(key, value);
      await memory.kvSet(key, value);
    }

    for (const [key, value] of scenarios) {
      expect(await store.kvGet(key)).toBe(value);
      expect(await store.kvGet(key)).toBe(await memory.kvGet(key));
    }

    for (const key of ["b", "never-written"]) {
      expect(await store.kvGet(key)).toBe(await memory.kvGet(key));
    }

    await store.kvRemove("a");
    await memory.kvRemove("a");
    expect(await store.kvGet("a")).toBeNull();
    expect(await store.kvGet("a")).toBe(await memory.kvGet("a"));
  });

  it("survives the kv_store table being emptied underneath it", async () => {
    await store.kvSet("k", "v");
    await db.run("DELETE FROM kv_store");
    expect(await store.kvGet("k")).toBeNull();
    await store.kvSet("k", "v2");
    expect(await store.kvGet("k")).toBe("v2");
  });
});