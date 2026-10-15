/**
 * Seed the demo scenario. `bun run seed`.
 *
 * Everything here is a real API call against real sandbox objects, per
 * ARCHITECTURE.md section 12 build-order item 5. No hand-inserted rows.
 *
 * Why this exists at all: the Spike proved the sandbox account contains ZERO
 * payments - only a $5,000 account adjustment (T1900). So there is nothing to
 * classify, and the identity question cannot be asked. This script creates the
 * first real one, with the identity fields written explicitly, which is the
 * only way to learn whether they come back.
 *
 * One step needs a human: PayPal order approval. The script prints a URL, the
 * buyer approves in a browser, then `bun run seed --capture` completes it. That
 * is not a gap in the automation - approval is a browser flow by design, and
 * pretending otherwise would mean faking the part that proves the integration.
 */

import { readFile, writeFile } from "node:fs/promises";
import { readOAuthToken, SANDBOX_BASE_URL } from "../src/adapters/token";
import { readTransactions } from "../src/adapters/inspect";
import { buildOrderPayload } from "../src/adapters/orderPayload";

const SANDBOX = SANDBOX_BASE_URL;

/** Identities the detectors will key on. These strings are the whole trick. */
const SCENARIO = [
  { key: "sub-netflix", label: "Netflix", amountCents: 1599, repeats: 4 },
  { key: "sub-adobe", label: "Adobe Creative Cloud", amountCents: 5999, repeats: 1 },
] as const;

type Order = { id: string; approveUrl: string };

const token = await mintToken();
if (token === null) {
  console.log("No credentials. Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET.");
  process.exit(0);
}

const statePath = "seed-state.json";

async function mintToken(): Promise<string | null> {
  const explicit = process.env["PAYPAL_ACCESS_TOKEN"];
  if (explicit !== undefined && explicit.length > 0) return explicit;
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

async function call(path: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(`${SANDBOX}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "PayPal-Request-Id": `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      ...(init.headers ?? {}),
    },
  });
  const body: unknown = await response.json();
  if (!response.ok) {
    const b = body as { message?: string; details?: unknown };
    throw new Error(`HTTP ${response.status}: ${b?.message ?? "unknown"} ${JSON.stringify(b?.details ?? "")}`);
  }
  return body;
}

/**
 * Create one order per scenario entry.
 *
 * The body comes from `buildOrderPayload`, which is tested against the
 * published Orders v2 schema. This function only performs the request.
 */
async function createOrder(entry: (typeof SCENARIO)[number]): Promise<Order> {
  const body = await call("/v2/checkout/orders", {
    method: "POST",
    body: JSON.stringify(buildOrderPayload(entry)),
  });

  const order = body as { id: string; links?: { rel: string; href: string }[] };
  const approveUrl =
    order.links?.find((l) => l.rel === "payer-action" || l.rel === "approve")?.href ?? "";
  return { id: order.id, approveUrl };
}

async function capture(orderId: string): Promise<string> {
  const body = (await call(`/v2/checkout/orders/${orderId}/capture`, {
    method: "POST",
    body: "{}",
  })) as { status?: string; purchase_units?: unknown[] };
  return body.status ?? "unknown";
}

const isCapture = process.argv.includes("--capture");

if (!isCapture) {
  console.log("spendless seed — creating real orders\n");
  const orders: Order[] = [];
  for (const entry of SCENARIO) {
    try {
      const order = await createOrder(entry);
      orders.push(order);
      console.log(`[created] ${entry.key}  order ${order.id}`);
    } catch (error) {
      console.log(`[FAILED ] ${entry.key}  ${(error as Error).message}`);
    }
  }

  // Stop here if nothing was created. The previous version fell through and
  // printed "open each URL" with an empty list, which reads like success and
  // would have sent you to the browser to approve nothing.
  if (orders.length === 0) {
    console.log("\nNo orders were created, so there is nothing to approve.");
    console.log("The failures above are the reason — fix those and re-run.");
    process.exit(1);
  }
  if (orders.length < SCENARIO.length) {
    console.log(
      `\nOnly ${orders.length}/${SCENARIO.length} orders were created. ` +
        `One is enough to answer the identity question.`,
    );
  }

  await writeFile(
    statePath,
    JSON.stringify({ orders: orders.map((o) => ({ id: o.id })) }, null, 2),
    "utf8",
  );

  console.log("\n\nPayPal needs a browser to approve each order. Sign in as the sandbox");
  console.log("BUYER account (Developer Dashboard > Testing Tools > Sandbox Accounts).");
  console.log("Then open each URL, pay, and run:\n");
  for (const [i, order] of orders.entries()) {
    console.log(`  ${i + 1}. ${order.approveUrl}`);
  }
  console.log(`\n  bun run seed --capture`);
  console.log("\nAn order created but never approved simply expires. That is fine —");
  console.log("approving one is enough to answer the identity question.");
} else {
  const state = await readFile(statePath, "utf8")
    .then((raw) => JSON.parse(raw) as { orders: { id: string }[] })
    .catch(() => null);
  if (state === null) {
    console.log("No seed-state.json. Run `bun run seed` first.");
    process.exit(0);
  }

  console.log("spendless seed — capturing approved orders\n");
  for (const order of state.orders) {
    try {
      console.log(`[captured] ${order.id} -> ${await capture(order.id)}`);
    } catch (error) {
      console.log(`[FAILED  ] ${order.id}  ${(error as Error).message}`);
    }
  }

  console.log("\n\nPayPal settles asynchronously. Wait ~30s, then re-run:");
  console.log("  bun run spike");
  console.log("\nThe spike will report which of invoice_id / custom_id / item name");
  console.log("survived the round trip. That answer decides the demo's framing.");
  console.log("\nFor reference, what is readable now:");
  const end = new Date();
  const start = new Date(end.getTime() - 31 * 86_400_000);
  const params = new URLSearchParams({
    start_date: start.toISOString(),
    end_date: end.toISOString(),
    page_size: "100",
  });
  const t = await call(`/v1/reporting/transactions?${params}`);
  for (const tx of readTransactions(t)) {
    console.log(
      `  ${tx.id}  ${tx.eventCode}  ${tx.amountCents}c  ${tx.currency}  key="${tx.merchantKey}"`,
    );
  }
}