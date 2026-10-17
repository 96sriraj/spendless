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
import { readFileSync } from "node:fs";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { createSqliteD1 } from "../support/sqliteD1";
import { createDatabase } from "@/db";
import worker, { type Env } from "../../worker/index";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");

/** Fixed clock so the seeded scenario - and therefore this response - is stable. */
const SEED_NOW = "2026-10-17T00:00:00.000Z";

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
  it("answers with an honest empty model when no database is bound", async () => {
    // A missing binding is the single most likely state on a demo machine: H3
    // (`wrangler login`) is still open, so `DB` may genuinely be absent. A 500
    // here would take the first screen down for a configuration reason, and a
    // non-zero figure would be worse than a zero. So: 200, and an empty model
    // that says it is empty.
    const response = await get("/api/state", {});
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      totalRiskCents: number;
      findings: unknown[];
      subscriptions: unknown[];
      lanes: unknown[];
      database: boolean;
    };
    expect(body.totalRiskCents).toBe(0);
    expect(body.findings).toEqual([]);
    expect(body.subscriptions).toEqual([]);
    expect(body.lanes).toEqual([]);
    expect(body.database).toBe(false);
  });

  it("returns a computed figure, not a placeholder", async () => {
    // The gate for this step. `PLACEHOLDER_RISK_CENTS` rendered convincingly and
    // nothing computed it, so no test could contradict it.
    const db = testDatabase();
    const seed = await import("@/services/seedHistory");
    await seed.seedHistory(createDatabase(db), { now: new Date(SEED_NOW) });

    const body = (await (await get("/api/state", { DB: db })).json()) as {
      totalRiskCents: number;
      database: boolean;
      subscriptions: { id: string }[];
    };

    expect(body.database).toBe(true);
    expect(body.subscriptions.length).toBeGreaterThan(0);
    expect(body.subscriptions.map((s) => s.id)).toContain("sub-netflix");
  });

  it("sums the figure from the findings it returns", async () => {
    const db = testDatabase();
    const seed = await import("@/services/seedHistory");
    await seed.seedHistory(createDatabase(db), { now: new Date(SEED_NOW) });

    const body = (await (await get("/api/state", { DB: db })).json()) as {
      totalRiskCents: number;
      findings: { savingCents: number }[];
    };

    const summed = body.findings.reduce((sum, f) => sum + f.savingCents, 0);
    expect(body.totalRiskCents).toBe(summed);
  });

  it("labels the lane each finding came from, so history is never shown as a payment", async () => {
    // D5. Without this the UI cannot say which of the three lanes produced the
    // figure, and seeded history gets presented as revenue PayPal reported.
    const db = testDatabase();
    const seed = await import("@/services/seedHistory");
    await seed.seedHistory(createDatabase(db), { now: new Date(SEED_NOW) });

    const body = (await (await get("/api/state", { DB: db })).json()) as {
      lanes: string[];
    };
    expect(body.lanes).toEqual(["seeded_history"]);
  });

  it("is safe to call repeatedly, because the client polls it", async () => {
    const db = testDatabase();
    const seed = await import("@/services/seedHistory");
    await seed.seedHistory(createDatabase(db), { now: new Date(SEED_NOW) });

    const first = await get("/api/state", { DB: db });
    const second = await get("/api/state", { DB: db });

    expect(second.status).toBe(200);
    const a = (await first.json()) as { totalRiskCents: number };
    const b = (await second.json()) as { totalRiskCents: number };
    expect(b.totalRiskCents).toBe(a.totalRiskCents);
  });

  it("never leaks a secret, whatever the database contains", async () => {
    const db = testDatabase();
    const raw = await (
      await get("/api/state", {
        DB: db,
        PAYPAL_CLIENT_SECRET: "secret-marker-456",
        OPENROUTER_API_KEY: "key-marker-789",
      })
    ).text();

    expect(raw).not.toContain("secret-marker-456");
    expect(raw).not.toContain("key-marker-789");
  });

  it("answers a JSON 404 for an unknown sub-path, because a 200 SPA would be read as data", async () => {
    const response = await get("/api/state/findings");
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toMatch(/application\/json/);
  });
});

function testDatabase(): D1Database {
  const sqlite = new BetterSqlite3(":memory:");
  sqlite.exec(readFileSync(path.join(REPO_ROOT, "src", "db", "schema.sql"), "utf8"));
  return createSqliteD1(sqlite) as unknown as D1Database;
}