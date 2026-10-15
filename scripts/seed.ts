/**
 * Seed the demo scenario. `bun run seed`.
 *
 * Everything here is a real API call against real sandbox objects, per
 * ARCHITECTURE.md section 12 build-order item 5. No hand-inserted rows.
 *
 * Why this exists: the Spike proved the sandbox account held ZERO payments -
 * only a $5,000 account adjustment (T1900). So there was nothing to classify,
 * and the identity question could not be asked. This creates the first real
 * one with the identity fields written explicitly.
 *
 * Two funding paths, tried in this order:
 *
 *   1. CARD (default). create -> confirm-payment-source -> capture, entirely
 *      over the API. Unattended, reproducible, no browser. This is the one that
 *      matters with the kill switch days away.
 *   2. BROWSER (`--method browser`). Falls back to the hosted approval screen.
 *      That screen failed on 2026-10-16 with PayPal's generic error while the
 *      order itself was created fine - see human-todo.md H1-05c for the known
 *      causes, the leading one being the buyer account's country.
 *
 * Both paths write the same three merchant-authored identity carriers, so the
 * round-trip answer is the same either way.
 */

import { writeFile } from "node:fs/promises";
import { readOAuthToken, SANDBOX_BASE_URL } from "../src/adapters/token";
import { readTransactions } from "../src/adapters/inspect";
import { buildOrderPayload } from "../src/adapters/orderPayload";
import { buildCardPaymentSource, SANDBOX_TEST_CARDS } from "../src/adapters/cardFunding";
import { isPaymentEvent, exclusionReason } from "../src/core/eventCodes";

const SANDBOX = SANDBOX_BASE_URL;

/** Identities the detectors will key on. These strings are the whole trick. */
const SCENARIO = [
  { key: "sub-netflix", label: "Netflix", amountCents: 1599 },
  { key: "sub-adobe", label: "Adobe Creative Cloud", amountCents: 5999 },
  { key: "sub-spotify", label: "Spotify", amountCents: 1199 },
] as const;

type Created = { key: string; id: string; approveUrl: string };

const token = await mintToken();
if (token === null) {
  console.log("No credentials. Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET.");
  process.exit(1);
}

const statePath = "seed-state.json";
const method = process.argv.includes("--method") ? "browser" : "card";

async function mintToken(): Promise<string | null> {
  const explicit = process.env["PAYPAL_ACCESS_TOKEN"];
  if (explicit !== undefined && explicit.trim().length > 0) return explicit;
  const id = process.env["PAYPAL_CLIENT_ID"];
  const secret = process.env["PAYPAL_CLIENT_SECRET"];
  if (id === undefined || secret === undefined) return null;

  const basic = Buffer.from(`${id}:${secret}`, "utf8").toString("base64");
  const response = await fetch(`${SANDBOX}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  return readOAuthToken(await response.json())?.accessToken ?? null;
}

async function call(
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${SANDBOX}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
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

function describeFailure(body: unknown): string {
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

async function createOrder(entry: (typeof SCENARIO)[number]): Promise<Created | null> {
  const { status, body } = await call("/v2/checkout/orders", {
    method: "POST",
    body: JSON.stringify(buildOrderPayload(entry)),
  });
  if (status < 200 || status >= 300) {
    console.log(`  [order failed] ${entry.key}: HTTP ${status} — ${describeFailure(body)}`);
    return null;
  }
  const order = body as { id: string; links?: { rel: string; href: string }[] };
  const approveUrl =
    order.links?.find((l) => l.rel === "payer-action" || l.rel === "approve")?.href ?? "";
  return { key: entry.key, id: order.id, approveUrl };
}

/** Fund an order with a sandbox test card. No browser involved. */
async function fundAndCapture(orderId: string, cardIndex: number): Promise<string> {
  const card = SANDBOX_TEST_CARDS[cardIndex % SANDBOX_TEST_CARDS.length]!;

  const confirm = await call(`/v2/checkout/orders/${orderId}/confirm-payment-source`, {
    method: "POST",
    body: JSON.stringify(buildCardPaymentSource(card)),
  });
  if (confirm.status < 200 || confirm.status >= 300) {
    return `funding failed: HTTP ${confirm.status} — ${describeFailure(confirm.body)}`;
  }

  const capture = await call(`/v2/checkout/orders/${orderId}/capture`, {
    method: "POST",
    body: "{}",
  });
  if (capture.status < 200 || capture.status >= 300) {
    return `capture failed: HTTP ${capture.status} — ${describeFailure(capture.body)}`;
  }
  const order = capture.body as { status?: string };
  return order.status ?? "unknown";
}

// ---------------------------------------------------------------------------

const created: Created[] = [];
console.log(`spendless seed — method: ${method}\n`);

for (const entry of SCENARIO) {
  const order = await createOrder(entry);
  if (order === null) continue;
  created.push(order);
  console.log(`  [order] ${entry.key}  ${order.id}`);
}

await writeFile(
  statePath,
  JSON.stringify({ orders: created.map((o) => ({ id: o.id, key: o.key })) }, null, 2),
  "utf8",
);

if (created.length === 0) {
  console.log("\nNo orders were created. The failures above are why — fix those first.");
  process.exit(1);
}

if (method === "browser") {
  console.log(`\n\nApprove these in a browser, signed in as the sandbox BUYER account:`);
  for (const [i, order] of created.entries()) {
    console.log(`\n  ${i + 1}. ${order.key}\n     ${order.approveUrl}`);
  }
  console.log(`\n  then:  bun run spike`);
  console.log(
    "\nIf the approval screen shows 'Things don't appear to be working', that is a\n" +
      "hosted checkout failure, not an API one — see human-todo.md H1-05c.",
  );
} else {
  console.log("\n\nFunding with sandbox test cards — no browser needed.\n");
  let succeeded = 0;

  // Sequential on purpose: sandbox rate-limits aggressively, and three
  // simultaneous captures is the fastest way to get a 429 instead of data.
  for (const [index, order] of created.entries()) {
    const result = await fundAndCapture(order.id, index);
    if (result === "COMPLETED") {
      succeeded += 1;
      console.log(`  [captured] ${order.key}  ${order.id}  COMPLETED`);
    } else {
      console.log(`  [FAILED   ] ${order.key}  ${order.id}  ${result}`);
    }
  }

  console.log(`\n${succeeded}/${created.length} payments completed.`);
  if (succeeded === 0) {
    console.log(
      "\nIf this says the card was declined or tokenisation failed, the sandbox may\n" +
        "require a vaulted card for Orders v2. Re-run with the browser path:\n" +
        "  bun run seed --method browser\n" +
        "and see human-todo.md H1-05c first — the hosted checkout needs the buyer\n" +
        "account's country set to US.",
    );
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// What the read path can now see
// ---------------------------------------------------------------------------

console.log("\nWaiting ~30s for PayPal to settle, then re-run `bun run spike`.\n");
console.log("For now, here is what Transaction Search already returns:\n");

const end = new Date();
const start = new Date(end.getTime() - 31 * 86_400_000);
const params = new URLSearchParams({
  start_date: start.toISOString(),
  end_date: end.toISOString(),
  page_size: "100",
});
const { status, body } = await call(`/v1/reporting/transactions?${params}`);

if (status !== 200) {
  console.log(`  could not read transactions: HTTP ${status} — ${describeFailure(body)}`);
} else {
  const rows = readTransactions(body);
  for (const tx of rows) {
    const event = isPaymentEvent(tx.eventCode)
      ? "payment"
      : (exclusionReason(tx.eventCode) ?? "?");
    console.log(
      `  ${tx.id}  ${tx.eventCode}  ${String(tx.amountCents).padStart(7)}c ${tx.currency}  key="${tx.merchantKey}"  [${event}]`,
    );
  }
  const payments = rows.filter((r) => isPaymentEvent(r.eventCode));
  console.log(
    `\n  ${payments.length} payment(s), ${rows.length} total. The identity column is\n` +
      `  the answer to S-2-live: anything other than "unknown" means a\n` +
      `  merchant-authored field survived the round trip.`,
  );
}