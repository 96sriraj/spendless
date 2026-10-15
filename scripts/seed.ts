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
import type { Currency } from "../src/core/validators";

const SANDBOX = SANDBOX_BASE_URL;

/**
 * Currency the orders are charged in.
 *
 * Settled by evidence, not by documentation. The spike read
 * `transaction_amount.currency_code` off a real transaction in this account:
 * **it settles in USD**, and USD order creation was accepted on the first run.
 *
 * Two wrong diagnoses got here, both recorded because each cost a cycle:
 *
 *   1. "Set the buyer account's country to US." No. Country is fixed at sandbox
 *      account creation and was never the cause.
 *   2. "Charge in INR, the account is India-based." No. Order creation rejects
 *      INR outright here while accepting 17 other codes, and the account
 *      settles in USD.
 *
 * So what was UNSUPPORTED_PAYEE_CURRENCY? That run predated
 * `application_context`, and its approval link came back with an empty
 * `merchantName=`. USD *plus* `application_context` had not been tried.
 *
 * Override with SEED_CURRENCY only if this account ever changes.
 */
const SEED_CURRENCY = (process.env["SEED_CURRENCY"] ?? "USD") as Currency;

/**
 * Identities the detectors will key on. These strings are the whole trick.
 *
 * Amounts are minor units reading as plausible USD prices, because the account
 * settles in USD. The detectors only care that the three charges for one
 * merchant are equal; a demo where Netflix costs six dollars undermines itself.
 */
const SCENARIO = [
  { key: "sub-netflix", label: "Netflix", amountCents: 1_599 },
  { key: "sub-adobe", label: "Adobe Creative Cloud", amountCents: 5_999 },
  { key: "sub-spotify", label: "Spotify", amountCents: 1_199 },
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
    body: JSON.stringify(buildOrderPayload(entry, SEED_CURRENCY, { modern: true })),
  });
  if (status < 200 || status >= 300) {
    console.log(`  [order failed] ${entry.key}: HTTP ${status} — ${describeFailure(body)}`);
    return null;
  }

  const order = body as { id: string; links?: { rel: string; href: string }[] };

// Print what PayPal actually said, in full, on the first order. Five attempts
  // were spent inferring the cause from a generic web page; the create-order
  // response is the one artefact nobody had actually read.
  if (entry === SCENARIO[0]) {
    console.log("\n  --- verbatim create-order response ---");
    console.log(JSON.stringify(body, null, 2));
    console.log("  --------------------------------------\n");
  }

  // Re-read it, so the state shown is PayPal's rather than our assumption.
  const reread = await call(`/v2/checkout/orders/${order.id}`);
  const r = reread.body as {
    status?: string;
    purchase_units?: { amount?: { currency_code?: string; value?: string } }[];
  };
  const unit = r?.purchase_units?.[0];
  console.log(
    `  [order] ${entry.key}  ${order.id}  status=${String(r?.status ?? "?")} ` +
      `${String(unit?.amount?.value ?? "?")} ${String(unit?.amount?.currency_code ?? "?")}`,
  );

  const approveUrl =
    order.links?.find((l) => l.rel === "payer-action")?.href ??
    order.links?.find((l) => l.rel === "approve")?.href ??
    "";
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
// Currency probe
// ---------------------------------------------------------------------------

/**
 * Which currencies this account will actually accept.
 *
 * Two failures in a row, in opposite directions, both about currency:
 *
 *   USD  order created, approval screen refused with UNSUPPORTED_PAYEE_CURRENCY
 *   INR  order creation refused with INVALID_CURRENCY_CODE
 *
 * So the payee takes neither. Rather than keep guessing from documentation —
 * which was wrong twice — ask the API. Each candidate is tried against order
 * creation and the verdict recorded.
 *
 * Note what a pass here does NOT prove: USD passed creation and still failed
 * at the payee. Creation acceptance and payee acceptance are different gates,
 * and only the approval screen tests the second one.
 */
async function probeCurrencies(): Promise<void> {
  const candidates = [
    "USD", "INR", "EUR", "GBP", "AUD", "CAD", "SGD", "AED", "JPY", "NZD",
    "HKD", "CHF", "SEK", "NOK", "DKK", "PLN", "CZK", "BRL", "MXN", "ZAR",
  ];
  const accepted: string[] = [];
  const rejected: string[] = [];

  console.log(`spendless seed — currency probe\n`);
  console.log("Asking the API what this account accepts, one currency at a time.\n");
  console.log("(Each attempt creates a CREATED order that will simply expire.)\n");

  for (const currency of candidates) {
    const { status, body } = await call("/v2/checkout/orders", {
      method: "POST",
      body: JSON.stringify(
        buildOrderPayload(
          { key: "probe", label: "probe", amountCents: 100 },
          currency as Currency,
        ),
      ),
    });
    if (status >= 200 && status < 300) {
      accepted.push(currency);
      console.log(`  accepted   ${currency}`);
    } else {
      rejected.push(currency);
      console.log(`  rejected   ${currency}  ${describeFailure(body).slice(0, 90)}`);
    }
    // Sandbox rate-limits. Twenty currencies back to back invites a 429, which
    // would read as "rejected" and send us down the wrong path entirely.
    await new Promise((r) => setTimeout(r, 250));
  }

  console.log(`\naccepted: ${accepted.length > 0 ? accepted.join(", ") : "(none)"}`);
  console.log(`rejected: ${rejected.length}`);

  if (accepted.length === 0) {
    console.log(
      "\nNothing was accepted, so this is not a currency choice — the account or the\n" +
        "app is not set up to take orders at all. Check that the app is on the\n" +
        "sandbox business account and that Transaction Search is enabled (H1-03).",
    );
    process.exit(1);
  }

  if (accepted.length > 1) {
    console.log(
      "\nMore than one was accepted, so this probe cannot be the last word: USD\n" +
        "passed creation before and still failed at the payee. Try each of the\n" +
        "accepted ones through the approval screen:\n\n" +
        `  $env:SEED_CURRENCY = "${accepted[0]}"; bun run seed`,
    );
  } else {
    console.log(`\nExactly one was accepted. Use it:\n\n  $env:SEED_CURRENCY = "${accepted[0]}"; bun run seed`);
  }
}

if (method === "probe") {
  await probeCurrencies();
  process.exit(0);
}

// ---------------------------------------------------------------------------

const created: Created[] = [];
console.log(`spendless seed — method: ${method}  currency: ${SEED_CURRENCY}\n`);

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
  // hang an invoice_id on. Unapproved CREATED orders sitting in the account
  // are noise, and they are exactly the sort of thing that later reads as a
  // real payment when someone goes looking.
  console.log("\n\nTRANSFER MODE — no orders created, and none needed.");
  console.log("A plain transfer carries no invoice_id or custom_id, so it cannot answer");
  console.log("S-2-live. What it DOES prove is that the read path sees real payments,");
  console.log("which is what everything downstream is built on.\n");
  console.log("Sign in as the sandbox BUYER at https://www.sandbox.paypal.com, then");
  console.log("open this and send money to your sandbox BUSINESS account's email:\n");
  console.log(`  ${transferLink("<business-account-email>", 1599)}\n`);
  console.log("Send a second one with a different amount if you want more rows.");
  console.log("Then wait ~30s and run `bun run spike`.");
  process.exit(0);
} else {
  console.log(`\n\n${created.length} orders created. Approve each one in a browser:\n`);
  for (const [i, order] of created.entries()) {
    console.log(`  ${i + 1}. ${order.key}\n     ${order.approveUrl}`);
  }
  console.log("\nBefore you open them:");
  console.log("  1. Sign in to sandbox.paypal.com as the BUYER first, same browser.");
  console.log("  2. Allow third-party cookies; use a profile with no extensions.");
  console.log("  3. These links are single-use. Do not reuse one from an earlier run.\n");
  console.log("  If the screen fails again: the base64 `code=` in the URL decodes to");
  console.log("  the real reason. It has read UNSUPPORTED_PAYEE_CURRENCY every time,");
  console.log("  which points at the PAYEE account's own setup rather than at anything");
  console.log("  we send - check which sandbox account the app is attached to.\n");
  console.log("  Or get a real payment into the account the easy way:");
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
      `  ${tx.id}  ${tx.eventCode}  ${String(tx.amountCents).padStart(7)}c ${tx.currencyCode}  key="${tx.merchantKey}"  [${event}]`,
    );
  }
  const payments = rows.filter((r) => isPaymentEvent(r.eventCode));
  console.log(
    `\n  ${payments.length} payment(s), ${rows.length} total. The identity column is\n` +
      `  the answer to S-2-live: anything other than "unknown" means a\n` +
      `  merchant-authored field survived the round trip.`,
  );
}