/**
 * HTTP plumbing shared by the sandbox scripts.
 *
 * Extracted from `seed.ts` so `capture.ts` and `spike.ts` can make the same
 * calls with the same error reporting. The thing worth keeping is
 * `describeFailure`: PayPal puts the actual reason in `details[].description`
 * and a generic sentence in `message`, so reading `message` alone is what made
 * earlier failures look like "the API just does not work".
 *
 * Not part of `src/` on purpose — these are operator scripts, and the
 * architecture tests forbid anything above the adapter layer from importing
 * `node:fs`. Keeping them here keeps that boundary honest.
 */

import { readOAuthToken, SANDBOX_BASE_URL } from "../src/adapters/token";

export const SANDBOX = SANDBOX_BASE_URL;

/** Where `seed.ts` records the orders it created, for `capture.ts` to re-read. */
export const statePath = "seed-state.json";

export type Created = {
  readonly key: string;
  readonly id: string;
  readonly approveUrl: string | null;
};

/**
 * A bearer token for the sandbox, from whichever credential the operator has.
 *
 * `PAYPAL_ACCESS_TOKEN` wins when set, because that is how the MCP server is
 * driven and having both available is what makes a spike run comparable.
 */
export async function mintToken(): Promise<string | null> {
  const explicit = process.env["PAYPAL_ACCESS_TOKEN"];
  if (explicit !== undefined && explicit.trim().length > 0) return explicit;

  const id = process.env["PAYPAL_CLIENT_ID"];
  const secret = process.env["PAYPAL_CLIENT_SECRET"];
  if (id === undefined || secret === undefined) return null;

  const basic = Buffer.from(`${id}:${secret}`, "utf8").toString("base64");
  const response = await fetch(`${SANDBOX}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  return readOAuthToken(await response.json())?.accessToken ?? null;
}

export type CallResult = { readonly status: number; readonly body: unknown };

export async function call(path: string, token: string, init: RequestInit = {}): Promise<CallResult> {
  const response = await fetch(`${SANDBOX}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      // Idempotency. Without it a retried POST capture can double-charge, which
      // on a sandbox balance nobody would notice and in a recorded demo
      // somebody very much would.
      "PayPal-Request-Id": `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      ...(init.headers ?? {}),
    },
  });

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

/** PayPal's actual reason, preferring `details` over the generic `message`. */
export function describeFailure(body: unknown): string {
  const b = body as { message?: string; details?: unknown[] } | null;
  const message = b?.message ?? "unknown error";
  const details = Array.isArray(b?.details)
    ? b.details
        .map((d) => (d as { description?: string })?.description ?? "")
        .filter(Boolean)
        .join("; ")
    : "";
  return details.length > 0 ? `${message} — ${details}` : message;
}
