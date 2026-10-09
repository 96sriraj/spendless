import { z } from "zod";
import { ALIAS, RAW } from "./cancelGuideData";

// Re-exported so callers (e.g. duplicateDetector) keep importing from cancelGuide.
export { ALIAS } from "./cancelGuideData";

const CancelGuideSchema = z.object({
  key: z.string().min(1),
  displayName: z.string().min(1),
  steps: z.array(z.string().min(1)).min(1),
  url: z.string().url(),
  deepLink: z.string().url().optional(),
});

export type CancelGuide = z.infer<typeof CancelGuideSchema>;

export function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

function genericGuide(name: string): CancelGuide {
  const q = encodeURIComponent(`${name} cancel subscription how to`);
  const url = `https://www.google.com/search?q=${q}`;
  return {
    key: "generic",
    displayName: name.trim() || "Subscription",
    steps: [
      `Search "${name} cancel subscription" in your account settings`,
      "Look for Billing / Subscription / Manage plan",
      "Select Cancel and confirm; check email for confirmation",
    ],
    url,
  };
}

/** Resolve a raw guide key into a validated CancelGuide, or null when invalid. */
function guideForKey(key: string): CancelGuide | null {
  const raw = RAW[key];
  if (raw === undefined) return null;
  const parsed = CancelGuideSchema.safeParse({
    key,
    displayName: raw.displayName,
    steps: [...raw.steps],
    url: raw.url,
    deepLink: raw.deepLink,
  });
  return parsed.success ? parsed.data : null;
}

export function getCancelGuide(name: string): CancelGuide {
  const trimmed = name.trim();
  if (trimmed.length === 0) return genericGuide("Subscription");
  const norm = normalizeName(trimmed);

  // Exact alias or direct RAW key.
  const rawKey = ALIAS[norm] ?? (norm in RAW ? norm : undefined);
  if (rawKey !== undefined) {
    const guide = guideForKey(rawKey);
    if (guide !== null) return guide;
  }

  // Substring fallback: "My Netflix Family" -> netflix.
  for (const [aliasName, target] of Object.entries(ALIAS)) {
    if (norm.includes(aliasName)) {
      const guide = guideForKey(target);
      if (guide !== null) return guide;
    }
  }

  return genericGuide(trimmed);
}

export function listSupportedMerchants(): readonly string[] {
  return Object.keys(RAW);
}
