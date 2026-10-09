/**
 * KVStore - the port that replaces Nixt's `durableNotepad`.
 *
 * Five lifted modules (priceHistory, unusedDetector, savingsLedger,
 * cancelIntent, insights) reach storage through these three methods. Depending
 * on this interface rather than on a concrete store is what makes the detector
 * graph pure: they take a store, so a test can hand them one, and the D1
 * adapter stays swappable without any module above it knowing D1 exists.
 *
 * The method names are deliberately unchanged from `durableNotepad`. Lifting
 * these modules is then a signature change and nothing else, and `grep kvSet`
 * still finds every call site (ARCHITECTURE.md section 5).
 */

import type { Database } from "./index";

export interface KVStore {
  kvGet(key: string): Promise<string | null>;
  kvSet(key: string, value: string): Promise<void>;
  kvRemove(key: string): Promise<void>;
}

/**
 * KVStore backed by D1.
 *
 * Last-write-wins per key, via an upsert. `durableNotepad` behaved the same
 * way, and `recordUsage` depends on it.
 */
export function createD1KvStore(db: Database, now = () => new Date().toISOString()): KVStore {
  return {
    async kvGet(key: string): Promise<string | null> {
      const row = await db.get<{ value: string }>(
        "SELECT value FROM kv_store WHERE key = ?",
        key,
      );
      return row?.value ?? null;
    },

    async kvSet(key: string, value: string): Promise<void> {
      await db.run(
        `INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        key,
        value,
        now(),
      );
    },

    async kvRemove(key: string): Promise<void> {
      await db.run("DELETE FROM kv_store WHERE key = ?", key);
    },
  };
}