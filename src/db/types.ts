/**
 * The slice of Cloudflare's D1 API this project uses.
 *
 * Declared here rather than pulled from `@cloudflare/workers-types` on purpose:
 * importing the global Worker types pollutes every module with runtime
 * `Request`/`Response`/`caches` globals that do not exist outside a Worker, and
 * `tsc` would then typecheck `src/` against a runtime that never runs it.
 *
 * These are structural types. The real `env.DB` binding satisfies them without
 * an adapter, and so does the SQLite driver the integration tests use. If D1
 * changes shape, this file is the single place that has to notice.
 */

export type D1Value = string | number | boolean | null | ArrayBuffer | ArrayBufferView;

export type D1Meta = {
  readonly changes?: number;
  readonly last_row_id?: number;
  readonly duration?: number;
  readonly rows_read?: number;
  readonly rows_written?: number;
};

export type D1Result<T = Record<string, unknown>> = {
  readonly results: T[];
  readonly success: boolean;
  readonly meta: D1Meta;
};

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(columnName?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = Record<string, unknown>>(
    statements: readonly D1PreparedStatement[],
  ): Promise<D1Result<T>[]>;
  exec(query: string): Promise<{ count: number; duration: number }>;
}