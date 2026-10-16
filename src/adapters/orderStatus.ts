/**
 * Reading an order's state, and saying what it means.
 *
 * The hosted approval screen hangs at "Pay Now" and spins forever. That symptom
 * is ambiguous: the page looks identical whether the buyer never confirmed a
 * funding source, whether the risk engine silently rejected, or whether the
 * payment **succeeded** and only the redirect back to the merchant failed.
 *
 * Those three need three different responses, and a spinner tells you none of
 * them. The order's own status is unambiguous, costs one GET, and needs no
 * browser — so it is the thing to ask before suggesting anything to a human.
 *
 * The `APPROVED` case is why this module exists rather than a console.log. An
 * approved order can be captured with a server-side POST, which turns a demo
 * that depends on a spinner resolving into one that does not.
 */

export type OrderState = {
  readonly id: string;
  /** Verbatim, or `ERROR` when PayPal returned a failure shape instead. */
  readonly status: string;
  /** True only for `APPROVED`: the one status a capture call will accept. */
  readonly capturable: boolean;
  readonly payerActionHref: string | null;
  /** PayPal's machine-readable error name, when there is one. */
  readonly problem: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @returns the parsed state, or `null` when the body is not an order at all.
 *   A `null` is meaningful — it means the response was not what we asked for,
 *   which is different from an order in a state we dislike.
 */
export function readOrderState(body: unknown): OrderState | null {
  if (!isRecord(body)) return null;

  // Failures arrive as `{ name, message, debug_id }` with no `status`. Reading
  // `status` first would report `undefined` and throw away the one field worth
  // having: the decoded error name that has unblocked this repeatedly.
  const name = body["name"];
  if (typeof name === "string" && name.length > 0) {
    return {
      id: typeof body["id"] === "string" ? body["id"] : "",
      status: "ERROR",
      capturable: false,
      payerActionHref: null,
      problem: name,
    };
  }

  const status = body["status"];
  if (typeof status !== "string") return null;

  const links = Array.isArray(body["links"]) ? body["links"] : [];
  const action = links.find(
    (link): link is { href: string; rel: string } =>
      isRecord(link) && link["rel"] === "payer-action" && typeof link["href"] === "string",
  );

  return {
    id: typeof body["id"] === "string" ? body["id"] : "",
    status,
    capturable: status === "APPROVED",
    payerActionHref: action?.href ?? null,
    problem: null,
  };
}

/**
 * One line a human can act on.
 *
 * Every branch ends in an instruction rather than a diagnosis, because the
 * whole cost of the last week was advice that turned out to be wrong three times
 * over. An unrecognised status is reported as unrecognised instead of being
 * folded into a familiar bucket — a new PayPal state must not be misdiagnosed as
 * an old known one.
 */
export function describeBlocker(state: OrderState): string {
  switch (state.status) {
    case "APPROVED":
      return "APPROVED - capture it server-side. Do not re-open the approval link.";

    case "COMPLETED":
      return "COMPLETED - already captured. No action needed.";

    case "CREATED":
      return (
        "CREATED - the buyer never confirmed a funding source. The approval link " +
        "must be opened and finished; a spinner on Pay Now means the confirm " +
        "call itself did not return."
      );

    case "PAYER_ACTION_REQUIRED":
      return (
        "PAYER_ACTION_REQUIRED - still waiting on the buyer. Re-open the " +
        "payer-action link below from a logged-in buyer session."
      );

    case "ERROR":
      return `${state.problem ?? "unknown error"} - PayPal rejected this outright. The name above is the reason.`;

    default:
      return `${state.status} - unrecognised status, report it rather than guessing.`;
  }
}
