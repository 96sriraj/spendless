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
 * KEYED ON THE BINDING, NOT A MODULE-LEVEL BOOLEAN
 * ---------------------------------------------------------------------------
 *
 * A plain `let done = false` would be correct in production — one D1 binding per
 * isolate — and wrong in tests, where each case gets a fresh in-memory database
 * that genuinely has not been initialised. A `WeakMap` keyed on the binding is
 * correct in both: one entry per database, and entries are collected with the
 * binding rather than pinning it for the isolate's lifetime.
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

const initialised = new WeakMap<D1Database, Promise<void>>();

export function ensureSchema(db: D1Database): Promise<void> {
  const existing = initialised.get(db);
  if (existing !== undefined) return existing;

  // A failed attempt is evicted rather than cached, so a transient D1 error is
  // retryable on the next request instead of poisoning the binding for good.
  const attempt = db
    .exec(schema)
    .then(() => undefined)
    .catch((error: unknown) => {
      initialised.delete(db);
      throw error;
    });

  initialised.set(db, attempt);
  return attempt;
}