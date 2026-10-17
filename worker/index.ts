/**
 * The Worker entry, at its most honest: one health route.
 *
 * This file exists to answer a question the rest of the UI cannot: **does the
 * build pipeline work end to end?** Vite compiles the client, workerd runs this,
 * the assets are served, and a browser gets a page that can talk to an API on
 * the same origin. If that holds locally it holds on `workers.dev`, and step 0's
 * gate — *the URL loads* — is a fact rather than an intention.
 *
 * Deliberately hand-rolled rather than a framework. One file, two routes, and
 * `AGENTS.md` is explicit that this project cannot afford a dependency that
 * changes shape three weeks before a submission.
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

export type Env = {
  /** D1 binding. Absent locally until step 1 creates it. */
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
   * A shape for the client to code against before the data path exists.
   *
   * Empty rather than throwing. A 501 here would make the whole shell look
   * broken on first run, and "nothing to show yet" is a different state from
   * "this endpoint is not implemented" — the UI renders them differently.
   */
  "GET /api/state": async () => json({ runId: null, findings: [], proposals: [] }),
};

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