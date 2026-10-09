/**
 * A D1Database over real SQLite.
 *
 * This exists so the database layer can be integration-tested against a real
 * SQL engine instead of a fake query builder. better-sqlite3 speaks the same
 * dialect D1 does, and `PRAGMA foreign_keys = ON` matches D1's behaviour -
 * without it a test would happily pass on a schema production rejects.
 *
 * It lives in test/ because it is a test double for a *platform*, not for
 * anything in this repo. Nothing under src/ may import it.
 */

import BetterSqlite3 from "better-sqlite3";
import type { Database as SqliteDatabase, Statement } from "better-sqlite3";
import type { D1Database, D1PreparedStatement, D1Result } from "@/db/types";

type Bindable = string | number | boolean | null | bigint | Buffer;

function toSqliteParam(value: unknown): Bindable {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint"
  ) {
    return value;
  }
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new TypeError(`Cannot bind ${typeof value} to a SQL parameter`);
}

class SqliteD1PreparedStatement implements D1PreparedStatement {
  readonly #db: SqliteDatabase;
  readonly #sql: string;
  readonly #params: unknown[] = [];

  constructor(db: SqliteDatabase, sql: string) {
    this.#db = db;
    this.#sql = sql;
  }

  bind(...values: unknown[]): D1PreparedStatement {
    this.#params.push(...values);
    return this;
  }

  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    const row = this.#stmt().get(...this.#bound()) as
      | Record<string, unknown>
      | undefined;
    if (row === undefined || row === null) return null;
    if (column === undefined) return row as T;
    return row[column] as T;
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const rows = this.#stmt().all(...this.#bound()) as T[];
    return { results: rows, success: true, meta: { changes: rows.length } };
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const info = this.#stmt().run(...this.#bound());
    return {
      results: [],
      success: true,
      meta: {
        changes: info.changes,
        last_row_id: Number(info.lastInsertRowid),
        duration: 0,
        rows_read: 0,
        rows_written: info.changes,
      },
    };
  }

  #bound(): Bindable[] {
    return this.#params.map(toSqliteParam);
  }

  #stmt(): Statement {
    return this.#db.prepare(this.#sql);
  }
}

export function createSqliteD1(database?: SqliteDatabase): D1Database {
  const db = database ?? new BetterSqlite3(":memory:");
  // D1 enforces foreign keys; SQLite's default is to ignore them. Matching
  // this is the difference between an honest integration test and a lie.
  db.pragma("foreign_keys = ON");

  return {
    prepare: (sql: string) => new SqliteD1PreparedStatement(db, sql),
    async batch<T = Record<string, unknown>>(
      statements: readonly D1PreparedStatement[],
    ): Promise<D1Result<T>[]> {
      const results: D1Result<T>[] = [];
      for (const statement of statements) {
        results.push((await statement.run<T>()) as D1Result<T>);
      }
      return results;
    },
    async exec(query: string): Promise<{ count: number; duration: number }> {
      db.exec(query);
      return { count: 0, duration: 0 };
    },
  };
}