/**
 * The Worker entry, at its most honest: one health route.
 *
 * This file exists to answer a question the rest of the UI cannot: **does the
 * build pipeline work end to end?** Vite compiles the client, workerd runs this,
 * the assets are served, and a browser gets a page that can talk to an API on
 * the same origin. If that holds locally it holds on `workers.dev`, and step 0's
 * gate — *the URL loads* — is a fact rather than an intention.
 *
 * Deliberately hand-rolled rather than a framework. One file, and `AGENTS.md` is
 * explicit that this project cannot afford a dependency that changes shape three
 * weeks before a submission.
 *
 * ---------------------------------------------------------------------------
 * SECRETS STAY SERVER-SIDE BECAUSE OF WHERE THIS FILE SITS
 * ---------------------------------------------------------------------------
 *
 * Nothing here reads `process.env`. Credentials arrive as bindings on `Env`,
 * are read inside a handler, and are never placed in a response body. The client
 * bundle has no access to an `Env` value, so there is nothing to leak — the
 * guarantee holds because of the architecture rather than because of a lint rule
 * somebody might delete. `wrangler types` generates this `Env` from
 * `wrangler.jsonc`, so a secret added there shows up here as a type error until
 * it is handled.
 *
 * The health route reports **which secrets are present, never their values**. It
 * is a public endpoint: it gets hit from a browser, captured in a screenshot,
 * and shown on stage.
 */

import { createDatabase } from "../src/db";
import { buildReadModel } from "../src/services/readModel";
import { seedScenario } from "../src/services/scenario";
import { ensureSchema } from "./schema";

export type Env = {
  /** D1 binding. Absent when the account is not linked (H3 in human-todo.md). */
  DB?: D1Database;
  /** Never sent to the browser. */
  PAYPAL_CLIENT_ID?: string;
  PAYPAL_CLIENT_SECRET?: string;
  OPENROUTER_API_KEY?: string;
  /**
   * The kill switch. Absent means live; any explicit falsy value halts
   * execution. `src/actions/killSwitch.ts` explains why that default is a
   * decision rather than an oversight.
   */
  EXECUTION_ENABLED?: string;
  REFUND_CAP_CENTS?: string;
};

type Route = (request: Request, env: Env, url: URL) => Response | Promise<Response>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

const routes: Record<string, Route> = {
  "GET /api/health": async (_request, env) =>
    json({
      ok: true,
      /**
       * Stated as a fact, not a promise: `connectPayPalMcp` refuses anything but
       * `SANDBOX` before it will spawn a server, so the UI's SANDBOX badge
       * cannot be showing something the code does not enforce.
       */
      environment: "sandbox",
      configured: {
        paypal: env.PAYPAL_CLIENT_ID !== undefined,
        openrouter: env.OPENROUTER_API_KEY !== undefined,
        database: env.DB !== undefined,
      },
    }),

  /**
   * The real read path.
   *
   * `PLACEHOLDER_RISK_CENTS` rendered convincingly and computed nothing — no test
   * could have contradicted a constant typed into a component. This route runs
   * the actual chain (`transactions → recurrence → subscriptions → insights →
   * total`) over real D1 rows, so the headline figure is a sum of rows that
   * arrived.
   *
   * Two behaviours are deliberate and both are contract-tested:
   *
   * - **No database is an empty model, not a 500.** H3 (`wrangler login`) is
   *   still open, so an unbound `DB` is a realistic state on a demo machine. A
   *   crash would take the first screen down for a configuration reason.
   * - **The schema is applied on first use.** Every statement in `schema.sql` is
   *   `IF NOT EXISTS`, so it is idempotent, and it runs once per isolate behind a
   *   memoised promise. A demo that needs a manual migration step before it will
   *   render is a demo that fails on the day.
   */
  "GET /api/state": async (_request, env) => {
    if (env.DB === undefined) {
      return json({ ...EMPTY_STATE, database: false });
    }

    const db = createDatabase(env.DB);
    await ensureSchema(env.DB);
    const model = await buildReadModel(db, new Date());

    return json({ ...model, database: true });
  },

  /**
   * The one-click scenario.
   *
   * `AGENTS.md` — "demo reliability beats features… so the demo is rehearsable
   * without hand-crafting state." Rehearsable is the operative word: on demo day
   * nobody is running a migration and writing SQL by hand.
   *
   * POST only, deliberately. A state-changing verb is a bad fit for a path a
   * client might poll, and a demo that reseeds itself mid-sentence is worse than
   * one that needs a button pressed.
   *
   * Replace, not accumulate — a second click must produce the same figure, or
   * the run cannot be rehearsed against a known number.
   */
  "POST /api/seed": async (_request, env) => {
    if (env.DB === undefined) {
      return json({ error: "no database configured" }, 503);
    }

    const db = createDatabase(env.DB);
    await ensureSchema(env.DB);
    const seeded = await seedScenario(db, new Date());

    return json({ ...seeded.model, database: true, seeded: {
      transactions: seeded.transactions,
      usage: seeded.usage,
    } });
  },
};

/**
 * What the client sees when there is nothing to compute from.
 *
 * `totalRiskCents: 0` rather than null: a zero is a real, renderable answer, and
 * null would push the UI into inventing a figure to display instead.
 */
const EMPTY_STATE = {
  generatedAt: null,
  totalRiskCents: 0,
  currency: null,
  findings: [],
  subscriptions: [],
  lanes: [],
  transactionCount: 0,
} as const;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const route = routes[`${request.method} ${url.pathname}`];

    if (route !== undefined) return route(request, env, url);

    // JSON rather than an HTML error page: every caller here is `fetch`, and a
    // client that has to sniff content types to discover it 404'd is a client
    // that will eventually mistake it for success.
    if (url.pathname.startsWith("/api/")) {
      return json({ error: "not found", path: url.pathname }, 404);
    }

    // The SPA shell, served from the assets binding. Not wired until
    // `wrangler.jsonc` declares `[assets]`, which lands with the Vite config.
    return new Response("spendless", {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
};