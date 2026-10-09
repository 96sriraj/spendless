/**
 * An in-memory KVStore.
 *
 * This is a real implementation of the port, not a mock - it holds real values
 * with real last-write-wins semantics. That distinction is the whole reason
 * the lifted detector graph can be unit-tested with zero mocks: the tests need
 * somewhere to put a price history, and this is somewhere to put it.
 *
 * It is also what a Worker uses for a single request's scratch state, and what
 * `bun run` scripts get for free.
 */

import type { KVStore } from "./kvStore";

export function createMemoryKvStore(
  seed: Readonly<Record<string, string>> = {},
): KVStore {
  const entries = new Map<string, string>(Object.entries(seed));

  return {
    async kvGet(key: string): Promise<string | null> {
      return entries.get(key) ?? null;
    },

    async kvSet(key: string, value: string): Promise<void> {
      entries.set(key, value);
    },

    async kvRemove(key: string): Promise<void> {
      entries.delete(key);
    },
  };
}