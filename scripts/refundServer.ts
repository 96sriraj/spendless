/**
 * The local refund sidecar. `bun run refund-server`.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SEPARATE PROCESS AND NOT A WORKER ROUTE
 * ---------------------------------------------------------------------------
 *
 * The product's `/api/actions/approve` runs inside **workerd** — both deployed
 * and under `bun run dev`, which uses `@cloudflare/vite-plugin`. workerd has no
 * `node:child_process`, so it cannot spawn `npx @paypal/mcp`, so it cannot issue
 * a real refund. That is not a bug to route around: it is why the Worker route
 * honestly returns `unavailableExecutor()` and says "nothing was sent to PayPal".
 *
 * This sidecar is the Option-A half of the demo. It runs under Node — where
 * spawning the MCP server works, proven by `actionExecutor.live.test.ts` — and
 * exposes exactly one money-moving endpoint for the UI to call during the video.
 * It reuses the *same* tested pieces as that live test: `connectPayPalMcp`,
 * `createMcpActionExecutor`, `createTokenProvider`. Nothing new touches money.
 *
 * ---------------------------------------------------------------------------
 * HOW A FINDING BECOMES A CAPTURE
 * ---------------------------------------------------------------------------
 *
 * The detectors key on merchant keys (`sub-netflix`); a refund needs a PayPal
 * capture id. `bun run capture --capture` writes that mapping into
 * `seed-state.json` under `captures`. This server reads it and refuses — out
 * loud — a subId it has no capture for, because a plausible-looking refund of a
 * capture that does not exist is exactly the lie the whole project avoids.
 *
 * ---------------------------------------------------------------------------
 * SANDBOX ONLY, AND SAID TWICE
 * ---------------------------------------------------------------------------
 *
 * `connectPayPalMcp` refuses anything but SANDBOX before it spawns. This file
 * adds nothing that could reach live money; it only wires the sandbox executor
 * to an HTTP port on localhost.
 */

import { createServer, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { connectPayPalMcp, type PayPalMcpConnection } from "@/adapters/mcp/server";
import { createMcpActionExecutor } from "@/adapters/mcp/McpPayPalExecutor";
import { createTokenProvider } from "@/adapters/tokenProvider";
import { statePath } from "./helpers";

const PORT = Number.parseInt(process.env["REFUND_SERVER_PORT"] ?? "8788", 10);
const TOKEN_URL = "https://api-m.sandbox.paypal.com/v1/oauth2/token";

const envClientId = process.env["PAYPAL_CLIENT_ID"];
const envClientSecret = process.env["PAYPAL_CLIENT_SECRET"];
if (envClientId === undefined || envClientSecret === undefined) {
  console.error("No PayPal credentials. Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET.");
  process.exit(1);
}
// Narrowed to plain strings so the narrowing survives into the hoisted
// `executor` function below — control-flow narrowing does not reach into it.
const clientId: string = envClientId;
const clientSecret: string = envClientSecret;

type SeedState = {
  readonly orders?: readonly { readonly id: string; readonly key: string }[];
  readonly captures?: Record<string, string>;
};

/**
 * Read the capture map fresh on every request.
 *
 * Deliberately not cached: the operator may run `bun run capture` between
 * refunds during a rehearsal, and a server holding a stale map would refuse a
 * capture that now exists. Reading a small JSON file per refund costs nothing.
 */
async function captureFor(subId: string): Promise<string | null> {
  try {
    const state = JSON.parse(await readFile(statePath, "utf8")) as SeedState;
    return state.captures?.[subId] ?? null;
  } catch {
    return null;
  }
}

/** One connection for the life of the process, reconnected if it drops. */
let connection: PayPalMcpConnection | null = null;

async function executor() {
  connection ??= await connectPayPalMcp({
    tokenProvider: createTokenProvider({ tokenUrl: TOKEN_URL, clientId, clientSecret }),
    bootTimeoutMs: 120_000,
  });
  return createMcpActionExecutor(connection.client);
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    // The UI is served from a different origin (Vite on :5173), so the browser
    // needs this to call the sidecar. Localhost-only, for a demo tool.
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "POST, OPTIONS",
  });
  res.end(text);
}

const server = createServer((req, res) => {
  if (req.method === "OPTIONS") {
    send(res, 204, {});
    return;
  }

  if (req.method === "GET" && req.url === "/health") {
    send(res, 200, { ok: true, environment: "sandbox" });
    return;
  }

  if (req.method !== "POST" || req.url !== "/local-refund") {
    send(res, 404, { error: "not found" });
    return;
  }

  let raw = "";
  req.on("data", (chunk) => {
    raw += chunk;
  });
  req.on("end", () => {
    void (async () => {
      let parsed: { subId?: unknown; amountCents?: unknown };
      try {
        parsed = JSON.parse(raw) as typeof parsed;
      } catch {
        send(res, 400, { error: "expected JSON { subId: string, amountCents?: number }" });
        return;
      }

      const subId = parsed.subId;
      if (typeof subId !== "string" || subId.length === 0) {
        send(res, 400, { error: "subId is required" });
        return;
      }

      const captureId = await captureFor(subId);
      if (captureId === null) {
        // Refused, not faked. No capture for this subId means there is nothing
        // honest to refund.
        send(res, 409, {
          ok: false,
          error:
            `No capture recorded for "${subId}" in ${statePath}. Run ` +
            "`bun run seed`, approve the orders, then `bun run capture --capture`.",
        });
        return;
      }

      const amountCents =
        typeof parsed.amountCents === "number" && Number.isFinite(parsed.amountCents)
          ? parsed.amountCents
          : undefined;

      try {
        const result = await (await executor()).refund({
          captureId,
          ...(amountCents === undefined ? {} : { amountCents }),
          currency: "USD",
          note: "spendless: unused subscription",
        });
        send(res, result.status === "completed" ? 200 : 502, {
          ok: result.status === "completed",
          subId,
          captureId,
          refundId: result.refundId,
          status: result.status,
          amountCents: result.amountCents,
          currency: result.currency,
          message:
            result.status === "completed"
              ? `Refund ${result.refundId} COMPLETED on capture ${captureId}.`
              : (result.message ?? `refund ${result.status}`),
        });
      } catch (error: unknown) {
        send(res, 502, {
          ok: false,
          subId,
          captureId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  });
});

server.listen(PORT, () => {
  console.log(`spendless refund sidecar — SANDBOX only`);
  console.log(`Listening on http://localhost:${PORT}`);
  console.log(`  POST /local-refund   { "subId": "sub-netflix", "amountCents"?: 1599 }`);
  console.log(`  GET  /health`);
  console.log(`\nThe UI calls this for the Option-A video. The Worker stays honest.`);
});

process.on("SIGINT", () => {
  void connection?.close().finally(() => process.exit(0));
});
