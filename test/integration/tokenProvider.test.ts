/**
 * Token minting and proactive refresh, against a real HTTP server.
 *
 * `token.ts` already derives *when* to refresh from what the server said about
 * `expires_in`. What was missing is the thing that acts on it — and that is the
 * part with teeth, because its failure mode is a mid-demo 401 rather than a
 * startup error. A demo that dies at minute two because a token quietly aged
 * out is the whole risk `AGENTS.md` warns about in different words.
 *
 * Tested against a real `node:http` server rather than a stubbed `fetch`. A
 * stubbed fetch would only prove that a hand-written fake returns what the fake
 * was told to return, which is the same mistake `db.test.ts` refuses to make.
 * The clock is injected instead — timing is the one thing an integration test
 * should not wait for.
 */

import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createTokenProvider } from "@/adapters/tokenProvider";

type Mint = {
  readonly expiresInSeconds: number;
  readonly status?: number;
  readonly garbage?: boolean;
};

interface Harness {
  readonly baseUrl: string;
  /** How many times the token endpoint was actually hit. */
  readonly calls: () => number;
  /** Every Authorization header the endpoint received. */
  readonly seen: () => readonly string[];
}

/**
 * A real OAuth-shaped endpoint. It counts hits and records the credentials it
 * was given, so the tests can assert on traffic rather than on return values.
 */
async function startTokenServer(
  plan: Mint | (() => Mint),
): Promise<Harness & { readonly close: () => Promise<void> }> {
  let calls = 0;
  const seen: string[] = [];

  const server: Server = createServer((req, res) => {
    calls += 1;
    seen.push(String(req.headers["authorization"] ?? ""));
    const mint = typeof plan === "function" ? plan() : plan;

    if ((mint.status ?? 200) >= 300) {
      res.writeHead(mint.status ?? 500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_client" }));
      return;
    }

    const body = mint.garbage
      ? { access_token: "", expires_in: 0 }
      : { access_token: `token-${calls}`, expires_in: mint.expiresInSeconds };

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    calls: () => calls,
    seen: () => seen,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const CREDENTIALS = { clientId: "id-123", clientSecret: "secret-456" };

describe("createTokenProvider", () => {
  const servers: { close: () => Promise<void> }[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.close()));
  });

  async function harness(plan: Mint | (() => Mint)) {
    const server = await startTokenServer(plan);
    servers.push(server);
    return server;
  }

  it("should mint a token on first use", async () => {
    const server = await harness({ expiresInSeconds: 32_400 });
    const provider = createTokenProvider({
      tokenUrl: `${server.baseUrl}/v1/oauth2/token`,
      ...CREDENTIALS,
    });

    expect(await provider.getToken()).toBe("token-1");
    expect(server.calls()).toBe(1);
  });

  it("should send the credentials as HTTP basic auth, not in the body", async () => {
    // Client-credentials over basic auth is PayPal's documented exchange. If this
    // ever regressed to form fields, the failure would be a 401 at demo time.
    const server = await harness({ expiresInSeconds: 32_400 });
    const provider = createTokenProvider({
      tokenUrl: `${server.baseUrl}/v1/oauth2/token`,
      ...CREDENTIALS,
    });

    await provider.getToken();

    const expected = `Basic ${Buffer.from("id-123:secret-456", "utf8").toString("base64")}`;
    expect(server.seen()).toEqual([expected]);
  });

  it("should reuse the cached token rather than re-minting on every call", async () => {
    // The single most valuable behaviour here. Re-minting per call would mean a
    // token request in front of every API call, which is both slow and a good
    // way to get rate-limited mid-demo.
    const server = await harness({ expiresInSeconds: 32_400 });
    const provider = createTokenProvider({
      tokenUrl: `${server.baseUrl}/v1/oauth2/token`,
      ...CREDENTIALS,
    });

    expect(await provider.getToken()).toBe("token-1");
    expect(await provider.getToken()).toBe("token-1");
    expect(await provider.getToken()).toBe("token-1");

    expect(server.calls()).toBe(1);
  });

  it("should re-mint once the refresh threshold has passed", async () => {
    // `nowMs` is injected rather than slept on. Waiting out a real token's
    // lifetime is not an option, and the scheduling arithmetic is already unit
    // tested in token.ts - what needs proving is that the provider acts on it.
    const server = await harness({ expiresInSeconds: 100 });
    let now = 1_000_000;

    const provider = createTokenProvider({
      tokenUrl: `${server.baseUrl}/v1/oauth2/token`,
      ...CREDENTIALS,
      nowMs: () => now,
    });

    expect(await provider.getToken()).toBe("token-1");

    // 80% of 100s is the refresh point. Just under it: still cached.
    now += 79_000;
    expect(await provider.getToken()).toBe("token-1");
    expect(server.calls()).toBe(1);

    // Past it: re-minted, before anything 401s.
    now += 2_000;
    expect(await provider.getToken()).toBe("token-2");
    expect(server.calls()).toBe(2);
  });

  it("should collapse concurrent callers onto one mint", async () => {
    // A naive implementation mints once per in-flight caller, so five parallel
    // adapter calls become five token requests and five chances to be
    // rate-limited. The demo reads several sources at once, so this is the
    // realistic case rather than a theoretical one.
    const server = await harness({ expiresInSeconds: 32_400 });
    const provider = createTokenProvider({
      tokenUrl: `${server.baseUrl}/v1/oauth2/token`,
      ...CREDENTIALS,
    });

    const tokens = await Promise.all([
      provider.getToken(),
      provider.getToken(),
      provider.getToken(),
      provider.getToken(),
      provider.getToken(),
    ]);

    expect(new Set(tokens)).toEqual(new Set(["token-1"]));
    expect(server.calls()).toBe(1);
  });

  it("should refuse to cache an unusable token, so a bad response fails loudly", async () => {
    // A response with an empty token or a zero expiry has nothing to schedule a
    // refresh against. Caching it would convert a clear startup failure into a
    // 401 halfway through the demo.
    const server = await harness({ expiresInSeconds: 32_400, garbage: true });
    const provider = createTokenProvider({
      tokenUrl: `${server.baseUrl}/v1/oauth2/token`,
      ...CREDENTIALS,
    });

    await expect(provider.getToken()).rejects.toThrow(/no usable token/i);
  });

  it("should surface the HTTP status when the endpoint rejects the credentials", async () => {
    // An expired sandbox token is the most likely real version of this, and the
    // status is what tells an operator whether to go and re-export it.
    const server = await harness({ expiresInSeconds: 32_400, status: 401 });
    const provider = createTokenProvider({
      tokenUrl: `${server.baseUrl}/v1/oauth2/token`,
      ...CREDENTIALS,
    });

    await expect(provider.getToken()).rejects.toThrow(/401/);
  });

  it("should retry a failed mint on the next call instead of caching the failure", async () => {
    // The failure that matters: a transient network blip must not poison the
    // provider for the rest of the process.
    let healthy = false;
    const server = await harness(() =>
      healthy
        ? { expiresInSeconds: 32_400 }
        : { expiresInSeconds: 32_400, status: 503 },
    );
    const provider = createTokenProvider({
      tokenUrl: `${server.baseUrl}/v1/oauth2/token`,
      ...CREDENTIALS,
    });

    await expect(provider.getToken()).rejects.toThrow(/503/);

    healthy = true;
    expect(await provider.getToken()).toBe("token-2");
  });
});
