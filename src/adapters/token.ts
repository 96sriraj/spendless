/**
 * OAuth client-credentials handling.
 *
 * PayPal issues a token from client ID + secret, and the response carries
 * `expires_in`. That number is the answer to S-0-05 — the docs claim 3-8 hours
 * while the sandbox response says 32400 seconds, which is 9. The refresh
 * interval in `token.ts` must be derived from what the server actually said,
 * never from a doc.
 *
 * Pure parsing only. Nothing here performs a request.
 */

export type OAuthToken = {
  readonly accessToken: string;
  readonly expiresInSeconds: number;
};

export const SANDBOX_BASE_URL = "https://api-m.sandbox.paypal.com";
export const PRODUCTION_BASE_URL = "https://api-m.paypal.com";

/**
 * Validate an OAuth token response.
 *
 * Returns null rather than a partial token. A token with no usable `expires_in`
 * is worse than no token: there is nothing to schedule a refresh against, so the
 * failure shows up as a mid-demo 401 instead of at startup.
 */
export function readOAuthToken(body: unknown): OAuthToken | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;

  const accessToken = record["access_token"];
  if (typeof accessToken !== "string" || accessToken.trim().length === 0) return null;

  const expiresIn = record["expires_in"];
  if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    return null;
  }

  return { accessToken, expiresInSeconds: expiresIn };
}

/**
 * Refresh this long before expiry.
 *
 * Enough margin to survive a slow request and one retry, without wasting most
 * of the token's life re-minting.
 */
export const REFRESH_MARGIN_RATIO = 0.8;

/** Seconds from now at which a refresh should be attempted. */
export function refreshAfterSeconds(expiresInSeconds: number): number {
  return Math.max(60, Math.floor(expiresInSeconds * REFRESH_MARGIN_RATIO));
}

/** True when a token issued `issuedAtMs` ago needs replacing. */
export function needsRefresh(
  issuedAtMs: number,
  expiresInSeconds: number,
  nowMs: number = Date.now(),
): boolean {
  const ageSeconds = (nowMs - issuedAtMs) / 1000;
  return ageSeconds >= refreshAfterSeconds(expiresInSeconds);
}