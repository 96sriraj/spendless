/**
 * Date chunking for the transaction-search path.
 *
 * PayPal caps a transaction-search window at 31 days, and the MCP wrapper
 * clamps client-side as well - silently. A caller who asks for a year through
 * an adapter that forwards the request gets one month and no error. That is a
 * data-loss bug that looks like success, which is the worst kind.
 *
 * So the adapter chunks, here, where the rule is testable without a sandbox.
 */

/** PayPal's documented maximum window for transaction search. */
export const PAYPAL_MAX_WINDOW_DAYS = 31;

const DAY_MS = 86_400_000;

export function chunkRange(
  range: { readonly start: Date; readonly end: Date },
  maxDays: number = PAYPAL_MAX_WINDOW_DAYS,
): { start: Date; end: Date }[] {
  const start = range.start.getTime();
  const end = range.end.getTime();

  // An inverted or zero-width range has nothing to fetch. Returning a single
  // degenerate chunk instead would produce one doomed API call.
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
  if (!Number.isFinite(maxDays) || maxDays <= 0) return [];

  const step = maxDays * DAY_MS;
  const chunks: { start: Date; end: Date }[] = [];

  // Contiguous, not overlapping: chunk[n].end === chunk[n+1].start. A gap of a
  // single millisecond would silently drop a charge on the boundary.
  for (let from = start; from < end; from += step) {
    chunks.push({
      start: new Date(from),
      end: new Date(Math.min(from + step, end)),
    });
  }

  return chunks;
}

/**
 * Merge per-chunk results, collapsing a transaction returned twice.
 *
 * Chunks share a boundary instant and PayPal's inclusivity at that boundary is
 * not documented, so the same charge can legitimately come back from two calls.
 * Two rows for one charge would inflate a merchant's series and could
 * manufacture a cadence that does not exist.
 */
export function mergeTransactions<T extends { readonly id: string }>(
  batches: readonly (readonly T[])[],
): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const batch of batches) {
    for (const item of batch) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      out.push(item);
    }
  }
  return out;
}