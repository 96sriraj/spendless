/**
 * The API contract, exercised through the real Worker handler.
 *
 * No HTTP server, no framework, no mock: the default export is called with a
 * real `Request` and asserted on the real `Response`. That is the cheapest
 * honest way to test a Worker — the handler *is* the unit, and a test server
 * would only be testing the server.
 *
 * `/api/health` is deliberately the first thing tested. Step 0's whole claim is
 * that the pipeline works, and a health route that returns the wrong shape is
 * the earliest possible evidence that it does not.
 */

import { describe, expect, it } from "vitest";
import worker, { type Env } from "../../worker/index";

type Fetch = (request: Request, env?: Env) => Promise<Response>;

const call: Fetch = (request, env = {}) => worker.fetch(request, env);

const get = (path: string, env?: Env): Promise<Response> =>
  call(new Request(`https://spendless.test${path}`), env);

describe("GET /api/health", () => {
  it("reports the environment as sandbox, unconditionally", async () => {
    const body = (await (await get("/api/health")).json()) as { environment: string };
    // This is the fact the UI's SANDBOX badge renders. It is not a display
    // string here — `connectPayPalMcp` refuses anything but SANDBOX before it
    // will spawn a server — so the two cannot drift apart.
    expect(body.environment).toBe("sandbox");
  });

  it("reports which secrets are present, and never their values", async () => {
    const response = await get("/api/health", {
      PAYPAL_CLIENT_ID: "id-marker-123",
      PAYPAL_CLIENT_SECRET: "secret-marker-456",
      OPENROUTER_API_KEY: "key-marker-789",
    });
    const raw = await response.text();

    // Public endpoint. It gets hit from a browser, screenshotted, and shown on
    // stage, so the check is on the whole body rather than on a shape.
    expect(raw).not.toContain("id-marker-123");
    expect(raw).not.toContain("secret-marker-456");
    expect(raw).not.toContain("key-marker-789");

    const body = JSON.parse(raw) as { configured: Record<string, boolean> };
    expect(body.configured).toEqual({
      paypal: true,
      openrouter: true,
      database: false,
    });
  });

  it("reports an absent secret as absent rather than as an error", async () => {
    // A missing key is a configuration state the UI has to render, not a
    // failure that should take the page down.
    const response = await get("/api/health");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; configured: Record<string, boolean> };
    expect(body.ok).toBe(true);
    expect(body.configured.paypal).toBe(false);
  });
});

describe("routing", () => {
  it("answers an unknown API path with JSON, not an HTML error page", async () => {
    const response = await get("/api/nope");
    expect(response.status).toBe(404);
    // A `fetch` caller that has to sniff content types to discover it 404'd is a
    // caller that will eventually read it as success.
    expect(response.headers.get("content-type")).toMatch(/application\/json/);
  });

  it("does not let a GET on a POST-only path fall through to the shell", async () => {
    // The shell answers 200 for everything that is not `/api/`, so an API route
    // reached with the wrong method must not quietly get the SPA back.
    const response = await call(new Request("https://spendless.test/api/health", { method: "POST" }));
    expect(response.status).toBe(404);
  });

  it("serves something for a non-API path, so the SPA has a host", async () => {
    const response = await get("/");
    expect(response.status).toBe(200);
  });
});

describe("GET /api/state", () => {
  it("returns the shape the client codes against before the data path exists", async () => {
    const body = (await (await get("/api/state")).json()) as {
      runId: string | null;
      findings: unknown[];
      proposals: unknown[];
    };
    // Empty rather than a 501: "nothing to show yet" and "this endpoint does
    // not exist" are different states, and the UI renders them differently.
    expect(body).toEqual({ runId: null, findings: [], proposals: [] });
  });
});