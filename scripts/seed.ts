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
 * Two funding paths, because approval is a browser flow and that is a
 * dependency we would rather not carry:
 *
 *   1. APPROVE (default). Creates the orders, then you approve each one in a
 *      browser as the sandbox buyer. This is the only path that writes a
 *      merchant-authored identity, because `invoice_id` / `custom_id` exist
 *      only on a merchant-initiated order. There is no API route around it:
 *      Orders v2's `confirm-payment-source` accepts a raw card in the schema
 *      but gates it behind PCI SAQ D compliance, and the sandbox refuses it
 *      with a bare 422 (2026-10-16). A `single_use_token` would need hosted
 *      fields, i.e. a browser again.
 *   2. TRANSFER (`--method transfer`). Prints a pre-filled sandbox "Send
 *      money" link instead. One click, no checkout flow, no cookies, no
 *      country problem — but a plain transfer carries NO invoice_id or
 *      custom_id, so it proves the read path sees real payments while proving
 *      nothing about identity. A fallback, not the answer.
 *
 * Both write through the same read path. See human-todo.md H1-05c.
 */

import { writeFile } from "node:fs/promises";
import { readOAuthToken, SANDBOX_BASE_URL } from "../src/adapters/token";
import { readTransactions } from "../src/adapters/inspect";
import { buildOrderPayload } from "../src/adapters/orderPayload";
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
const method = process.argv.includes("--method")
  ? (process.argv[process.argv.indexOf("--method") + 1] ?? "approve")
  : "approve";

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

/**
 * A pre-filled sandbox Send Money link.
 *
 * Not a substitute for approving an order - a transfer carries no
 * `invoice_id` and no `custom_id`. It exists so the read path can be proven
 * end to end even when the hosted checkout refuses to render: one click, no
 * cookies, no country dependency.
 */
function transferLink(receiver: string, amountCents: number): string {
  const params = new URLSearchParams({
    email: receiver,
    amount: (amountCents / 100).toFixed(2),
    currencyCode: "USD",
    note: "spendless seed",
  });
  return `https://www.sandbox.paypal.com/myaccount/send?${params.toString()}`;
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

if (method === "transfer") {
  // No order is created in transfer mode: a transfer has no purchase unit to
  // hang an invoice_id on. Orders are cancelled so they cannot be mistaken for
  // something that was paid.
  for (const order of created) {
    await call(`/v2/checkout/orders/${order.id}`, { method: "PATCH", body: JSON.stringify([{ op: "replace", path: "/intent", value: "CAPTURE" }]) }).catch(() => undefined);
  }

  console.log("\n\nTRANSFER MODE — orders above were created but NOT fundable this way.");
  console.log("A plain transfer carries no invoice_id or custom_id, so it cannot answer");
  console.log("S-2-live. What it does prove is that the read path sees real payments.\n");
  console.log("Sign in as the sandbox BUYER, open this, and send money to your");
  console.log("sandbox BUSINESS account's email:\n");
  console.log(`  ${transferLink("<business-account-email>", 1599)}\n`);
  console.log("Then re-run `bun run spike`.");
} else {
  console.log(`\n\n${created.length} orders created. Approve each one in a browser:\n`);
  for (const [i, order] of created.entries()) {
    console.log(`  ${i + 1}. ${order.key}\n     ${order.approveUrl}`);
  }
  console.log("\nBefore you open them - this is what breaks the hosted screen:");
  console.log("  1. The BUYER sandbox account's country must be US. Non-US sandbox");
  console.log("     accounts fail with exactly 'Things don't appear to be working'.");
  console.log("  2. Sign in to sandbox.paypal.com as the buyer FIRST, same browser.");
  console.log("  3. Allow third-party cookies; try a clean profile with no extensions.");
  console.log("  4. These links are single-use. Do not reuse one from an earlier run.\n");
  console.log("  If the screen still fails, that is a PayPal web checkout problem, not");
  console.log("  ours - the orders above are real and valid. Then try:");
  console.log("    bun run seed --method transfer");
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