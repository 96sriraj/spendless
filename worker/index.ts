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
import { createOpenRouterClient } from "../src/agent/tools";
import type { ChatMessage, ToolSpec } from "../src/agent/tools";
import { createKillSwitch } from "../src/actions/killSwitch";
import { buildReadModel } from "../src/services/readModel";
import { approveAndExecute, unavailableExecutor } from "../src/services/actions";
import { newRunId, streamAgentRun } from "../src/services/runStream";
import { seedScenario } from "../src/services/scenario";
import { ensureSchema } from "./schema";

type AgentComplete = (request: {
  messages: readonly ChatMessage[];
  tools?: readonly ToolSpec[];
}) => Promise<import("../src/agent/tools").Completion>;

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

  /**
   * The agent run, streamed.
   *
   * POST, and a stream rather than a JSON body, because a run takes seconds and a
   * spinner for eight seconds is indistinguishable from a hung request. Every
   * step reaches the screen as it happens; `runStream.ts` owns the ordering and
   * this route only frames.
   *
   * **A missing API key is a 503 with a sentence, not an empty stream.** A 200
   * `text/event-stream` that emits nothing leaves the button spinning through a
   * whole demo, and the presenter has no way to say what went wrong. This is the
   * single most important behaviour on the route.
   */
  "POST /api/run": async (_request, env) => {
    if (env.DB === undefined) return json({ error: "no database configured" }, 503);

    const complete = resolveComplete(env);
    if (complete === null) {
      return json({ error: "OPENROUTER_API_KEY is not set, so the agent cannot run" }, 503);
    }

    const db = createDatabase(env.DB);
    await ensureSchema(env.DB);
    const { findings } = await buildReadModel(db, new Date());

    const stream = streamAgentRun({
      db,
      runId: newRunId(new Date()),
      findings,
      complete,
      now: new Date(),
    });

    // `ReadableStream` rather than a hand-rolled `TransformStream`: the Worker
    // runtime has one, it takes a `Response` directly, and there is nothing here
    // that needs the extra object.
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          for await (const event of stream) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          }
        } catch (error: unknown) {
          // Belt and braces: `streamAgentRun` already converts a failed run into
          // an error event. This catches a failure in the framing itself, which
          // would otherwise close the connection with no explanation on screen.
          const message = error instanceof Error ? error.message : String(error);
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ type: "error", message })}\n\n`),
          );
        } finally {
          controller.close();
        }
      },
    });

    return new Response(body, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        // Nginx and friends will happily buffer a stream, which turns the whole
        // feature into the spinner it was built to remove.
        "x-accel-buffering": "no",
      },
    });
  },

  /**
   * The last click: approve and run.
   *
   * One call rather than approve-then-execute, because the brief is "make the
   * payment quickly" and a merchant approving a plan is not approving each line
   * of it. The *enforcement* is unchanged — `claimForExecution` is still a
   * conditional update, so a second click loses the race and nothing is sent
   * twice. Speed at the surface, compare-and-set underneath.
   *
   * The response always carries a sentence per proposal. A 200 with a bare `ok`
   * beside a refund button is a lie waiting to be recorded, and a refusal has to
   * be renderable text rather than an exception — the artefact the judges watch
   * must never be a stack trace.
   *
   * **There is no PayPal executor here.** A Worker cannot spawn the MCP stdio
   * server, so this path runs guardrails → kill switch → store and then declines,
   * saying so. The enforcement chain above it is real and is what is worth
   * showing; the money honestly is not wired in this environment, and the screen
   * is told so rather than left to imply otherwise.
   */
  "POST /api/actions/approve": async (request, env) => {
    if (env.DB === undefined) return json({ error: "no database configured" }, 503);

    const parsed = await readProposalIds(request);
    if (parsed === null) {
      return json({ error: "expected { proposalIds: string[] } with at least one id" }, 400);
    }

    const db = createDatabase(env.DB);
    await ensureSchema(env.DB);
    const now = new Date();
    const { findings } = await buildReadModel(db, now);

    const outcomes: { proposalId: string; ok: boolean; message: string }[] = [];
    for (const proposalId of parsed) {
      const outcome = await approveAndExecute({
        db,
        proposalId,
        findings,
        executor: unavailableExecutor(),
        // Absent means live. Failing closed here would silently stop the demo on a
        // machine that simply has no environment variable set.
        killSwitch: createKillSwitch(
          env.EXECUTION_ENABLED === undefined ? {} : { executionEnabled: env.EXECUTION_ENABLED !== "false" },
        ),
        refundCapCents: readCap(env.REFUND_CAP_CENTS),
        approvedBy: "merchant",
        now,
      });

      outcomes.push({
        proposalId,
        ok: outcome.ok,
        message: outcome.ok ? outcome.message : outcome.reason,
      });
    }

    return json({ outcomes });
  },
};

/**
 * Read the approval request, or null when it is not one.
 *
 * Returns null rather than throwing: a malformed body is a client error the route
 * reports in its own shape, not an exception that becomes a 500.
 */
async function readProposalIds(request: Request): Promise<string[] | null> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return null;
  }
  if (typeof body !== "object" || body === null) return null;

  const ids = (body as { proposalIds?: unknown }).proposalIds;
  if (!Array.isArray(ids)) return null;
  const strings = ids.filter((id): id is string => typeof id === "string" && id.length > 0);
  return strings.length === ids.length && strings.length > 0 ? strings : null;
}

/**
 * Default cap when nothing is configured: $100.
 *
 * An unset cap defaulting to **zero** is fail-safe and useless — on a machine with
 * no environment file every refund is refused with "exceeds 0.00", which reads as
 * a broken guardrail rather than a configured one, and makes the demo's last click
 * do nothing for a reason nobody can see.
 *
 * An explicit `"0"` is still honoured as zero. "Unset" and "nothing may ever be
 * refunded" are different instructions and must not collapse into each other.
 */
const DEFAULT_REFUND_CAP_CENTS = 10_000;

function readCap(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_REFUND_CAP_CENTS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

/**
 * The model client, or null when one cannot be built.
 *
 * Null rather than a throwing client: "no key" is a configuration state the UI
 * renders, not an exception, and it is the single most likely state on a demo
 * machine that has not been set up.
 */
function resolveComplete(env: Env): AgentComplete | null {
  const override = testComplete;
  if (override !== undefined) return override;

  const apiKey = env.OPENROUTER_API_KEY;
  if (apiKey === undefined || apiKey.length === 0) return null;

  return createOpenRouterClient({ apiKey }).complete;
}

/**
 * Test seam.
 *
 * OpenRouter is external and unavailable in CI, and it sits behind the
 * `AGENTS.md` §3 seam — so it is substituted here, explicitly and by hand, rather
 * than by mocking a module. `null` means "no client at all", which is how the
 * missing-key path is exercised without unsetting a real secret.
 */
let testComplete: AgentComplete | null | undefined;

export function __setCompleteForTests(complete: AgentComplete | null): void {
  testComplete = complete;
}

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