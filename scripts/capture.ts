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
 *   bun run capture              report status for every seeded order
 *   bun run capture --approve    confirm any PAYER_ACTION_REQUIRED order via API
 *   bun run capture --capture    also capture the ones that are APPROVED
 *   bun run capture --approve --capture   do both — the one-command demo setup
 *
 * ---------------------------------------------------------------------------
 * WHY --approve EXISTS: THE HOSTED SCREEN IS UNRELIABLE
 * ---------------------------------------------------------------------------
 *
 * The PayPal sandbox hosted checkout hangs at "Pay Now" — every funding source,
 * including a funded PayPal balance, shows "unavailable at this time" and the
 * confirm call never returns. Measured against a fresh US buyer account on
 * 2026-10-23; it is a sandbox-platform failure, not an account one, so a new
 * account does not fix it.
 *
 * `--approve` routes around it. `confirm-payment-source` with a standard sandbox
 * test card (`4111111111111111`) moves an order from PAYER_ACTION_REQUIRED to
 * APPROVED through the API, no browser involved. The capture that follows is the
 * same server-side POST it always was. This is what makes the demo rehearsable:
 * `bun run seed` then `bun run capture --approve --capture` produces real
 * captures with no manual step.
 *
 * Safe to run repeatedly: confirm only fires on PAYER_ACTION_REQUIRED, capture
 * only on APPROVED, and an order already COMPLETED reports as such and is left
 * alone.
 */

import { readFile } from "node:fs/promises";
import { readOrderState, describeBlocker } from "@/adapters/orderStatus";
import { mintToken, call, describeFailure, statePath } from "./helpers";

/**
 * The canonical PayPal sandbox test Visa. Verified live 2026-10-23: it confirms
 * an order via `confirm-payment-source` where the hosted screen hangs. Not a
 * secret — it is a published test number and works only in sandbox.
 */
const TEST_CARD = { number: "4111111111111111", expiry: "2027-01", name: "John Doe", security_code: "123" };

interface SeedState {
  readonly orders: readonly { readonly id: string; readonly key: string }[];
  /**
   * Capture ids this script has taken, keyed by the merchant key the order was
   * seeded under (`sub-netflix` etc.). Written back here so the local refund
   * sidecar can resolve a finding's subId to the real capture it must reverse —
   * the detectors key on merchant keys, and a refund needs a capture id.
   */
  readonly captures?: Record<string, string>;
}

const shouldCapture = process.argv.includes("--capture");
const shouldApprove = process.argv.includes("--approve");

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
const captured: Record<string, string> = { ...(seedState.captures ?? {}) };

for (const order of seedState.orders) {
  const { status: httpStatus, body } = await call(`/v2/checkout/orders/${order.id}`, token);
  let state = readOrderState(body);

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

  // Approve via API when asked, routing around the hung hosted screen. Only an
  // order genuinely waiting on the buyer is confirmed; anything else is left as
  // it is, so this is safe to re-run.
  if (!state.capturable && state.status === "PAYER_ACTION_REQUIRED" && shouldApprove) {
    const confirm = await call(`/v2/checkout/orders/${order.id}/confirm-payment-source`, token, {
      method: "POST",
      body: JSON.stringify({ payment_source: { card: TEST_CARD } }),
    });
    if (confirm.status >= 200 && confirm.status < 300) {
      state = readOrderState(confirm.body) ?? state;
      console.log(`      -> confirmed via API (test card). status=${state.status}`);
    } else {
      console.log(`      -> confirm FAILED: HTTP ${confirm.status} — ${describeFailure(confirm.body)}`);
    }
  }

  if (!state.capturable) {
    if (state.payerActionHref !== null && !shouldApprove) {
      console.log(`      approval link: ${state.payerActionHref}`);
      console.log(`      (or skip the browser: re-run with --approve)`);
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
    // Record the first capture id under this order's merchant key so the refund
    // sidecar can find the real capture to reverse. One order, one capture here.
    if (ids.length > 0 && ids[0] !== undefined) {
      captured[order.key] = ids[0];
    }
  } else {
    console.log(`      -> capture FAILED: HTTP ${status} — ${describeFailure(captureBody)}`);
  }
}

// Persist the capture map back, merged with whatever was there. Written
// whenever we captured anything, so the refund sidecar has real ids to resolve.
if (shouldCapture && Object.keys(captured).length > 0) {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(
    statePath,
    JSON.stringify({ orders: seedState.orders, captures: captured }, null, 2),
    "utf8",
  );
  console.log(`\nWrote ${Object.keys(captured).length} capture id(s) to ${statePath}.`);
  for (const [key, id] of Object.entries(captured)) {
    console.log(`  ${key} -> ${id}`);
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
