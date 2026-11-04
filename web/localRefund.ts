/**
 * The Option-A bridge: the UI asking a local Node sidecar to move real money.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SEPARATE CALL FROM /api/actions/approve
 * ---------------------------------------------------------------------------
 *
 * The Worker route (`/api/actions/approve`) runs the full guardrail chain and
 * then *honestly declines* — a Worker cannot spawn PayPal's MCP server, so it
 * cannot refund. That path is correct for the deployed build (Option B) and is
 * left exactly as it is.
 *
 * This module is the video path (Option A). It talks to `scripts/refundServer.ts`
 * running under Node on localhost, which *can* spawn the MCP server and issue a
 * real sandbox refund. The sidecar resolves a finding's `subId` to the real
 * capture id written by `bun run capture --capture`.
 *
 * ---------------------------------------------------------------------------
 * THE DESIGN RULE: TRY, THEN FALL BACK — NEVER PRETEND
 * ---------------------------------------------------------------------------
 *
 * `isReachable` is a fast probe so the UI can tell which demo it is in without
 * blocking. When the sidecar is absent (the deployed build, or dev with no
 * sidecar running), the caller falls back to the Worker route and the screen
 * says "nothing was sent to PayPal". It never shows a fabricated success. A
 * refund the user can see is a refund that actually happened.
 */

/**
 * Where the sidecar listens. Build-time configurable, localhost by default.
 *
 * `import.meta.env` is Vite's, so this is baked at build time and never a secret
 * — it is only a port on the operator's own machine.
 */
const SIDECAR_BASE =
  (import.meta.env?.["VITE_REFUND_SERVER"] as string | undefined) ?? "http://localhost:8788";

export type LocalRefundResult = {
  readonly ok: boolean;
  readonly subId: string;
  readonly refundId?: string;
  readonly status?: string;
  readonly amountCents?: number | null;
  readonly currency?: string;
  readonly message: string;
};

/**
 * Is the sidecar up?
 *
 * A 400ms timeout, because this gates a button: a judge must not watch a dead
 * localhost port hang the UI for the TCP default. Unreachable is a normal,
 * expected state (it is the deployed build), not an error.
 */
export async function isReachable(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 400);
    const response = await fetch(`${SIDECAR_BASE}/health`, { signal: controller.signal });
    clearTimeout(timer);
    return response.ok;
  } catch {
    return false;
  }
}

/** Ask the sidecar to refund one capture, resolved from `subId`. */
export async function requestLocalRefund(
  subId: string,
  amountCents: number | null,
): Promise<LocalRefundResult> {
  try {
    const response = await fetch(`${SIDECAR_BASE}/local-refund`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        subId,
        ...(amountCents === null ? {} : { amountCents }),
      }),
    });
    const body = (await response.json().catch(() => ({}))) as Partial<LocalRefundResult> & {
      error?: string;
    };
    return {
      ok: body.ok === true,
      subId,
      ...(body.refundId === undefined ? {} : { refundId: body.refundId }),
      ...(body.status === undefined ? {} : { status: body.status }),
      ...(body.amountCents === undefined ? {} : { amountCents: body.amountCents }),
      ...(body.currency === undefined ? {} : { currency: body.currency }),
      message: body.message ?? body.error ?? `refund failed (${response.status})`,
    };
  } catch (error: unknown) {
    return {
      ok: false,
      subId,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
