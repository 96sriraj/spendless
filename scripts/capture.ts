/**
 * Re-read every seeded order, and capture any that reached APPROVED.
 *
 * This exists because of a specific failure. The hosted approval screen spins
 * forever at "Pay Now", and a spinner is ambiguous — the page looks identical
 * whether the buyer never confirmed a funding source, whether risk silently
 * rejected, or whether the payment **succeeded** and only the redirect back to
 * the merchant never fired.
 *
 * Those need three different responses and the browser tells you none of them.
 * The order status does, it costs one GET, and it needs no browser.
 *
 * The `APPROVED` case is why this is worth having. An approved order can be
 * captured with a server-side POST, so a demo whose payment step depends on a
 * spinner resolving does not have to.
 *
 *   bun run capture            report status for every seeded order
 *   bun run capture --capture  also capture the ones that are APPROVED
 *
 * Safe to run repeatedly: capture only fires on APPROVED, and an order already
 * COMPLETED reports as such and is left alone.
 */

import { readFile } from "node:fs/promises";
import { readOrderState, describeBlocker } from "@/adapters/orderStatus";
import { mintToken, call, describeFailure, statePath } from "./helpers";

interface SeedState {
  readonly orders: readonly { readonly id: string; readonly key: string }[];
}

const shouldCapture = process.argv.includes("--capture");

const token = await mintToken();
if (token === null) {
  console.log("No credentials. Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET.");
  process.exit(1);
}

let seedState: SeedState;
try {
  seedState = JSON.parse(await readFile(statePath, "utf8")) as SeedState;
} catch {
  console.log(`No ${statePath} to read. Run \`bun run seed\` first.`);
  process.exit(1);
}

if (seedState.orders.length === 0) {
  console.log(`No orders recorded in ${statePath}. Run \`bun run seed\` first.`);
  process.exit(1);
}

console.log(`\nReading ${seedState.orders.length} seeded order(s) from PayPal.`);
console.log(
  `A spinner on the approval page cannot tell you which of these you are in.\n` +
    `This can, and it needs no browser.\n`,
);

function readCaptureIds(body: unknown): string[] {
  const units = (body as { purchase_units?: unknown[] } | null)?.purchase_units;
  if (!Array.isArray(units)) return [];
  const ids: string[] = [];
  for (const unit of units) {
    const captures = (unit as { payments?: { captures?: unknown[] } } | null)?.payments?.captures;
    if (!Array.isArray(captures)) continue;
    for (const capture of captures) {
      const id = (capture as { id?: unknown } | null)?.id;
      if (typeof id === "string") ids.push(id);
    }
  }
  return ids;
}

let capturable = 0;

for (const order of seedState.orders) {
  const { status: httpStatus, body } = await call(`/v2/checkout/orders/${order.id}`, token);
  const state = readOrderState(body);

  if (state === null) {
    console.log(`  [${order.key}] HTTP ${httpStatus} — not an order response:`);
    console.log(`      ${describeFailure(body)}`);
    continue;
  }

  console.log(`  [${order.key}] ${order.id}`);
  console.log(`      status=${state.status}  ${describeBlocker(state)}`);

  if (state.problem !== null) {
    console.log(`      PayPal said: ${describeFailure(body)}`);
  }

  if (!state.capturable) {
    if (state.payerActionHref !== null) {
      console.log(`      approval link: ${state.payerActionHref}`);
    }
    continue;
  }

  capturable += 1;

  if (!shouldCapture) {
    console.log("      -> APPROVED. Re-run with --capture to take the payment.");
    continue;
  }

  // Capture is the one call here that moves money, so it is opt-in. An
  // accidental capture during diagnosis is indistinguishable afterwards from a
  // deliberate one, which is exactly the confusion this script removes.
  const { status, body: captureBody } = await call(
    `/v2/checkout/orders/${order.id}/capture`,
    token,
    { method: "POST", body: "{}" },
  );

  if (status >= 200 && status < 300) {
    const ids = readCaptureIds(captureBody);
    console.log(`      -> CAPTURED (${ids.length > 0 ? ids.join(", ") : "id not reported"}).`);
    console.log("         That is a real payment. Wait ~30s, then run `bun run spike`.");
  } else {
    console.log(`      -> capture FAILED: HTTP ${status} — ${describeFailure(captureBody)}`);
  }
}

if (capturable === 0) {
  console.log(
    "\nNone are APPROVED, so no amount of server-side retrying will help — the\n" +
      "buyer has to finish the page. The lines above name which status you are in.\n",
  );
} else if (!shouldCapture) {
  console.log(`\n${capturable} order(s) APPROVED. Re-run with --capture to take the money.\n`);
} else {
  console.log("\nDone. `bun run spike` will now see the payments.\n");
}
