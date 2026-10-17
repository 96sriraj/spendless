import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { createSqliteD1 } from "../support/sqliteD1";
import { ensureSchema, splitStatements } from "../../worker/schema";
import { createDatabase } from "@/db";
import { listTransactions } from "@/db/transactions";
import type { D1Database } from "@/db/types";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");

/**
 * The schema has to survive **D1's** statement splitter, not SQLite's.
 *
 * ---------------------------------------------------------------------------
 * THE BUG THIS FILE EXISTS FOR
 * ---------------------------------------------------------------------------
 *
 * `schema.sql` line 10 contains a semicolon inside a `--` comment:
 *
 *     --  2. Currency is USD or INR. USD because the PayPal sandbox is USD; INR
 *
 * `better-sqlite3.exec()` hands the whole string to `sqlite3_exec`, which
 * understands comments properly and does not care. D1's `exec()` splits the
 * input on `;` first, so that semicolon cuts a comment in half and leaves a
 * chunk containing no statement:
 *
 *     D1_EXEC_ERROR: SQL code did not contain a statement.
 *
 * Every integration test passed, because the fake was *more permissive than the
 * real service*. That is the worst possible direction for a test double to be
 * wrong in, and it is invisible until a demo machine hits it. So this file pins
 * the behaviour, and `sqliteD1.ts` now reproduces D1's splitting.
 */

describe("ensureSchema", () => {
  it("applies a schema containing semicolons inside comments", async () => {
    // The literal reproduction. Nothing else in the suite catches this: the only
    // reason it was found is a request to a running dev server.
    const db = betterSqlite3Database();
    await expect(ensureSchema(db)).resolves.toBeUndefined();

    // Every table exists, so the schema really did apply rather than being
    // silently skipped.
    const rows = await createDatabase(db).all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    );
    expect(rows.map((r) => r.name)).toContain("transactions");
    expect(rows.map((r) => r.name)).toContain("subscriptions");
  });

  it("is safe to run twice against the same binding", async () => {
    const db = betterSqlite3Database();
    await ensureSchema(db);
    await expect(ensureSchema(db)).resolves.toBeUndefined();
  });

  it("initialises each binding separately rather than trusting a module-level flag", async () => {
    // Two bindings, two databases, neither of them initialised to start with. A
    // `let done = false` would run the schema once and leave the second database
    // with no tables — and every test that followed would fail in a way that
    // looked like a product bug.
    const first = betterSqlite3Database();
    const second = betterSqlite3Database();

    await ensureSchema(first);
    await ensureSchema(second);

    for (const db of [first, second]) {
      const rows = await createDatabase(db).all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table'",
      );
      expect(rows.map((r) => r.name)).toContain("transactions");
    }
  });

  it("does not poison a binding after a failure", async () => {
    // A transient D1 error must be retryable. Caching the rejection would turn
    // one blip into a permanently broken screen.
    const broken = {
      prepare: () => ({
        run: async () => {
          throw new Error("D1 unavailable");
        },
      }),
    } as unknown as D1Database;

    await expect(ensureSchema(broken)).rejects.toThrow("D1 unavailable");

    const healthy = betterSqlite3Database();
    await expect(ensureSchema(healthy)).resolves.toBeUndefined();
  });

  it("leaves a database usable, so a row can actually be written afterwards", async () => {
    const db = betterSqlite3Database();
    await ensureSchema(db);

    const { insertTransaction } = await import("@/db/transactions");
    await expect(
      insertTransaction(createDatabase(db), {
        id: "tx-1",
        merchantName: "sub-x",
        amountCents: 500,
        currency: "USD",
        capturedAt: "2026-10-17T00:00:00.000Z",
        lane: "seeded_history",
      }),
    ).resolves.toBeUndefined();

    expect(await listTransactions(createDatabase(db))).toHaveLength(1);
  });
});

function betterSqlite3Database(): D1Database {
  const sqlite = new BetterSqlite3(":memory:");
  return createSqliteD1(sqlite) as unknown as D1Database;
}

/**
 * The statement splitter, pinned against the shapes `schema.sql` actually uses.
 *
 * D1's own `exec()` splitting turned out to reject this schema outright:
 *
 *     D1_EXEC_ERROR: Error in line 1: PRAGMA foreign_keys = ON;: incomplete input
 *
 * which is a second, independent way the real service and the fake disagree —
 * and it was found by curling the running dev server, not by a test. Rather than
 * reverse-engineer a splitter that is documented only as "splits on
 * semicolons", `ensureSchema` now does the splitting itself and sends one
 * statement at a time. Deterministic, and the result can be asserted on.
 */
describe("splitStatements", () => {
  it("splits a multi-statement schema into one statement per entry", () => {
    const statements = splitStatements(
      "CREATE TABLE a (id TEXT);\nCREATE INDEX i ON a (id);",
    );
    expect(statements).toEqual(["CREATE TABLE a (id TEXT)", "CREATE INDEX i ON a (id)"]);
  });

  it("ignores a semicolon inside a -- comment", () => {
    // Line 10 of schema.sql. The original bug: this cut a comment in half and
    // the fragment that followed contained no statement.
    const statements = splitStatements(
      "-- USD because the sandbox is USD; INR because nixt assumed it.\nCREATE TABLE a (id TEXT);",
    );
    expect(statements).toEqual(["CREATE TABLE a (id TEXT)"]);
  });

  it("keeps a semicolon inside a string literal, because it is not a delimiter", () => {
    // The CHECK constraints are full of quoted values. A naive split on `;`
    // survives this schema only by luck, and would break the first time a
    // constraint gained a semicolon.
    const statements = splitStatements(
      "CREATE TABLE a (c TEXT CHECK (c IN ('x;y', 'z')));",
    );
    expect(statements).toEqual(["CREATE TABLE a (c TEXT CHECK (c IN ('x;y', 'z')))"]);
  });

  it("drops empty fragments, so a trailing newline is not a statement", () => {
    expect(splitStatements("CREATE TABLE a (id TEXT);\n\n")).toEqual([
      "CREATE TABLE a (id TEXT)",
    ]);
  });

  it("produces statements that each run on their own", async () => {
    // The property that actually matters: whatever the splitter emits has to be
    // independently executable, or `ensureSchema` still fails at runtime.
    const db = betterSqlite3Database();
    const statements = splitStatements(SCHEMA_TEXT);

    expect(statements.length).toBeGreaterThan(5);
    for (const statement of statements) {
      await db.prepare(statement).run();
    }

    const tables = await createDatabase(db).all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    );
    expect(tables.map((t) => t.name)).toContain("transactions");
  });
});

/** Referenced so the fixture reads as intentional rather than leftover. */
export const SCHEMA_PATH = path.join(REPO_ROOT, "src", "db", "schema.sql");
export const SCHEMA_TEXT = readFileSync(SCHEMA_PATH, "utf8");