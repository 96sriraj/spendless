/**
 * Schema initialisation, run on first use.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS NO `migrations/` DIRECTORY
 * ---------------------------------------------------------------------------
 *
 * Every statement in `schema.sql` is `CREATE TABLE IF NOT EXISTS` or
 * `CREATE INDEX IF NOT EXISTS`. The file is idempotent by construction, so a
 * migration runner would have one job — deciding when to run it — and getting
 * that wrong is how a demo fails. `package.json` pointed `db:migrate` at a
 * `migrations/` folder that does not exist, so the script could only ever fail.
 *
 * So this runs the schema once per binding, memoised. Cheap, self-healing after
 * a `wrangler d1 execute`, and impossible to forget. When the schema does grow
 * real migrations with `ALTER TABLE`, this is the file that stops being the right
 * answer.
 *
 * ---------------------------------------------------------------------------
 * WHY WE SPLIT THE SQL OURSELVES INSTEAD OF CALLING `D1.exec()`
 * ---------------------------------------------------------------------------
 *
 * Two separate failures, both found by curling a running dev server rather than
 * by a test, and both because `test/support/sqliteD1.ts` was *more permissive
 * than the real service* — the worst direction for a test double to be wrong in:
 *
 *   1. `schema.sql` line 10 has a semicolon inside a `--` comment
 *      ("…the PayPal sandbox is USD; INR"). D1_EXEC_ERROR: SQL code did not
 *      contain a statement.
 *   2. After comments were stripped, the same call failed again:
 *      D1_EXEC_ERROR: Error in line 1: PRAGMA foreign_keys = ON;: incomplete
 *      input.
 *
 * (2) means D1's `exec()` splitter is not "split on semicolons" in any form that
 * survives this schema, and it is documented only as such. Rather than
 * reverse-engineer it, this file does the splitting — quote-aware, so a
 * `CHECK (c IN ('x;y'))` is not cut in half — and sends one statement per
 * `prepare()`. No splitter to disagree with, and the result is assertable in a
 * test, which `exec()`'s was not.
 *
 * The test double now reproduces the naive `;` split, so neither failure can
 * come back unnoticed.
 *
 * ---------------------------------------------------------------------------
 * COMMENTS CARRY NOTHING TO A DATABASE
 * ---------------------------------------------------------------------------
 *
 * Line comments only. `schema.sql` uses no block comments, and stripping `/*`
 * without a real SQL parser would corrupt any string literal that happens to
 * contain it — a far worse failure than leaving block comments in place.
 *
 * ---------------------------------------------------------------------------
 * THE SCHEMA IS IMPORTED AS TEXT, NOT READ AT RUNTIME
 * ---------------------------------------------------------------------------
 *
 * A Worker has no filesystem, so `node:fs` is not an option here even with
 * `nodejs_compat`. Vite's `?raw` import bundles the SQL into the Worker as a
 * string, which keeps `schema.sql` the single source of truth — no generated
 * copy to drift out of sync with the file the tests read.
 */

import schema from "../src/db/schema.sql?raw";
import type { D1Database } from "../src/db/types";

/**
 * Split SQL into individual statements that can each be prepared on their own.
 *
 * Comments are **discarded, not preserved**, so a caller cannot hand back a
 * fragment with half a line comment still attached. Semicolons inside `--`
 * comments and inside single-quoted literals are not delimiters.
 *
 * Single quotes only, because that is all `schema.sql` uses. A real tokenizer
 * would also need to know about `$$` dollar-quoting, escaped quotes, and
 * `"identifier"` names; writing a half-correct one and calling it a tokenizer
 * would be worse than a documented narrow scope.
 */
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let inString = false;
  let inLineComment = false;

  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i]!;

    if (inLineComment) {
      // Dropped entirely, newline included. Nothing downstream wants it.
      if (char === "\n") inLineComment = false;
      continue;
    }

    if (inString) {
      current += char;
      if (char === "'" && sql[i + 1] === "'") {
        // A doubled quote is an escaped quote, not the end of the string.
        current += sql[i + 1];
        i += 1;
      } else if (char === "'") {
        inString = false;
      }
      continue;
    }

    if (char === "'") {
      inString = true;
      current += char;
      continue;
    }

    if (char === "-" && sql[i + 1] === "-") {
      inLineComment = true;
      continue;
    }

    if (char === ";") {
      const trimmed = current.trim();
      if (trimmed.length > 0) statements.push(trimmed);
      current = "";
      continue;
    }

    current += char;
  }

  const tail = current.trim();
  if (tail.length > 0) statements.push(tail);
  return statements;
}

const STATEMENTS = splitStatements(schema);

const initialised = new WeakMap<D1Database, Promise<void>>();

export function ensureSchema(db: D1Database): Promise<void> {
  const existing = initialised.get(db);
  if (existing !== undefined) return existing;

  // A failed attempt is evicted rather than cached, so a transient D1 error is
  // retryable on the next request instead of poisoning the binding for good.
  const attempt = (async () => {
    for (const statement of STATEMENTS) {
      await db.prepare(statement).run();
    }
  })().catch((error: unknown) => {
    initialised.delete(db);
    throw error;
  });

  initialised.set(db, attempt);
  return attempt;
}