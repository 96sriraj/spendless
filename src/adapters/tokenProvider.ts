/**
 * Minting a token once, and keeping it fresh.
 *
 * `token.ts` already answers *when* a token needs replacing, derived from the
 * `expires_in` the server actually returned rather than from documentation. This
 * is the half that acts on that answer, and its failure mode is what makes it
 * worth its own tests: not a startup error, but a **mid-demo 401**, several
 * minutes in, with a judge watching.
 *
 * Three properties earn their keep:
 *
 * 1. **Cache.** Re-minting per API call puts a token request in front of every
 *    read, which is slow and a reliable way to get rate-limited on the day.
 * 2. **Collapse concurrent mints.** The demo reads several sources at once. A
 *    naive provider mints once per in-flight caller, so five parallel reads
 *    become five token requests.
 * 3. **Never cache a bad result.** An empty token or a zero expiry has nothing
 *    to schedule against; caching it turns a loud startup failure into a quiet
 *    one halfway through the demo.
 *
 * Nothing here imports `node:fs`, which is what keeps the architecture gate
 * satisfiable once this is wired into the adapters.
 */

import { readOAuthToken, needsRefresh, type OAuthToken } from "./token";

export type TokenProviderConfig = {
  /** Full URL of the OAuth token endpoint. */
  readonly tokenUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
  /** Injected so refresh scheduling is testable without waiting out a token. */
  readonly nowMs?: () => number;
};

export type TokenProvider = {
  /** A token that is valid now, minting or refreshing only when needed. */
  getToken(): Promise<string>;
  /** Whether a token is currently cached and still inside its refresh window. */
  isFresh(): boolean;
};

export function createTokenProvider(config: TokenProviderConfig): TokenProvider {
  const nowMs = config.nowMs ?? Date.now;

  let cached: OAuthToken | null = null;
  let issuedAtMs = 0;
  /**
   * The in-flight mint, shared by every concurrent caller.
   *
   * Held rather than awaited immediately so five parallel reads produce one
   * request. Cleared on settle, including on failure, so a transient blip does
   * not poison the provider for the rest of the process.
   */
  let inFlight: Promise<string> | null = null;

  async function mint(): Promise<OAuthToken> {
    const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`, "utf8").toString(
      "base64",
    );

    const response = await fetch(config.tokenUrl, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = null;
    }

    if (!response.ok) {
      // The status is what tells an operator whether to go re-export a token.
      const detail = (body as { error_description?: string } | null)?.error_description;
      throw new Error(
        `PayPal token endpoint returned HTTP ${response.status}${detail === undefined ? "" : ` — ${detail}`}`,
      );
    }

    const token = readOAuthToken(body);
    if (token === null) {
      throw new Error("PayPal token response had no usable token or expiry");
    }
    return token;
  }

  async function resolve(): Promise<string> {
    if (cached !== null && !needsRefresh(issuedAtMs, cached.expiresInSeconds, nowMs())) {
      return cached.accessToken;
    }

    if (inFlight !== null) return inFlight;

    const pending = mint()
      .then((token) => {
        cached = token;
        issuedAtMs = nowMs();
        return token.accessToken;
      })
      .finally(() => {
        inFlight = null;
      });

    inFlight = pending;
    return pending;
  }

  return {
    getToken: resolve,
    isFresh: () =>
      cached !== null && !needsRefresh(issuedAtMs, cached.expiresInSeconds, nowMs()),
  };
}
