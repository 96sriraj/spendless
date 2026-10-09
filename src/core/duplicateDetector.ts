/**
 * Duplicate detection — flags near-identical subscriptions (Phase-1 S8).
 * Pure + deterministic; reuses merchant canonicalisation from cancelGuide.
 */

import { ALIAS, normalizeName } from "./cancelGuide";
import { toMonthlyCents } from "./money";
import type { Subscription } from "./validators";

export type DuplicateFlag = {
  readonly kind: "duplicate";
  readonly subId: string;
  readonly title: string;
  readonly subtitle: string;
  readonly savingCents: number;
  readonly cta: string;
  readonly confidence: number;
};

// Longest keys first so "youtube premium" wins over "youtube" in contains-fallback.
const ALIAS_ENTRIES: readonly (readonly [string, string])[] = Object.entries(ALIAS).sort(
  (a, b) => b[0].length - a[0].length,
);

function canonical(name: string): string {
  const norm = normalizeName(name);
  const direct = ALIAS[norm];
  if (direct !== undefined) return direct;
  for (const [key, target] of ALIAS_ENTRIES) {
    if (norm.includes(key)) return target;
  }
  return norm;
}

function jaro(a: string, b: string): number {
  if (a === b) return 1;
  const aLen = a.length;
  const bLen = b.length;
  if (aLen === 0 || bLen === 0) return 0;
  const matchDistance = Math.floor(Math.max(aLen, bLen) / 2) - 1;
  const aMatches: boolean[] = new Array(aLen).fill(false);
  const bMatches: boolean[] = new Array(bLen).fill(false);
  let matches = 0;
  for (let i = 0; i < aLen; i += 1) {
    const start = Math.max(0, i - matchDistance);
    const end = Math.min(i + matchDistance + 1, bLen);
    for (let j = start; j < end; j += 1) {
      if (bMatches[j] || a.charAt(i) !== b.charAt(j)) continue;
      aMatches[i] = true;
      bMatches[j] = true;
      matches += 1;
      break;
    }
  }
  if (matches === 0) return 0;
  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < aLen; i += 1) {
    if (!aMatches[i]) continue;
    while (!bMatches[k]) k += 1;
    if (a.charAt(i) !== b.charAt(k)) transpositions += 1;
    k += 1;
  }
  const halfTranspositions = transpositions / 2;
  return (matches / aLen + matches / bLen + (matches - halfTranspositions) / matches) / 3;
}

function jaroWinkler(a: string, b: string): number {
  const base = jaro(a, b);
  let prefix = 0;
  const limit = Math.min(4, a.length, b.length);
  while (prefix < limit && a.charAt(prefix) === b.charAt(prefix)) prefix += 1;
  return base + prefix * 0.1 * (1 - base);
}

function duplicateConfidence(ca: string, cb: string): number | null {
  if (ca === cb) return 0.9;
  const jw = jaroWinkler(ca, cb);
  if (jw > 0.8) return Math.min(1, Math.round(jw * 100) / 100);
  return null;
}

export function detectDuplicates(subs: readonly Subscription[]): DuplicateFlag[] {
  const flags: DuplicateFlag[] = [];
  const canon = subs.map((s) => canonical(s.name));
  for (let i = 0; i < subs.length; i += 1) {
    for (let j = i + 1; j < subs.length; j += 1) {
      const confidence = duplicateConfidence(canon[i]!, canon[j]!);
      if (confidence === null) continue;
      const a = subs[i]!;
      const b = subs[j]!;
      flags.push({
        kind: "duplicate",
        subId: a.id,
        title: `${a.name} & ${b.name} look like duplicates`,
        subtitle: `You may be paying for ${a.name} and ${b.name} twice. Keep one?`,
        savingCents: Math.min(
          toMonthlyCents(a.amountCents, a.billingCycle),
          toMonthlyCents(b.amountCents, b.billingCycle),
        ),
        cta: "Keep one?",
        confidence,
      });
    }
  }
  return flags;
}