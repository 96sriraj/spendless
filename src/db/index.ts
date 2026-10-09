/**
 * The database access layer.
 *
 * A thin, typed wrapper over D1. It exists so that everything above it depends
 * on `Database` rather than on D1, and so that the query surface in this repo
 * is small enough to read in one sitting. There is deliberately no query
 * builder - raw SQL plus zod, the same idiom Nixt used (ARCHITECTURE.md
 * section 5).
 */

import type { D1Database } from "./types";

export type RunResult = {
  readonly changes: number;
  readonly lastRowId: number | null;
};

export interface Database {
  /** First row, or null. Never undefined - callers branch on null. */
  get<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T | null>;
  /** All rows; an empty array when there are none. */
  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]>;
  /** A statement that changes rows. Constraint violations reject. */
  run(sql: string, ...params: unknown[]): Promise<RunResult>;
  /** One round trip, many statements. */
  batch(statements: readonly { sql: string; params?: readonly unknown[] }[]): Promise<void>;
}

export function createDatabase(db: D1Database): Database {
  return {
    async get<T>(sql: string, ...params: unknown[]): Promise<T | null> {
      return db.prepare(sql).bind(...params).first<T>();
    },

    async all<T>(sql: string, ...params: unknown[]): Promise<T[]> {
      const result = await db.prepare(sql).bind(...params).all<T>();
      return result.results;
    },

    async run(sql: string, ...params: unknown[]): Promise<RunResult> {
      const result = await db.prepare(sql).bind(...params).run();
      return {
        changes: result.meta.changes ?? 0,
        lastRowId: result.meta.last_row_id ?? null,
      };
    },

    async batch(
      statements: readonly { sql: string; params?: readonly unknown[] }[],
    ): Promise<void> {
      await db.batch(
        statements.map((s) => db.prepare(s.sql).bind(...(s.params ?? []))),
      );
    },
  };
}

export * from "./types";