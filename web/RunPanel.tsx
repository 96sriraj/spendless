/**
 * The run log.
 *
 * ---------------------------------------------------------------------------
 * WHY `fetch` AND NOT `EventSource`
 * ---------------------------------------------------------------------------
 *
 * A run has to be *started* by a POST — it creates a run, spends a model call,
 * and costs money. `EventSource` is GET-only and cannot carry a body, so it
 * cannot start one. The stream therefore arrives as a `fetch` response body and
 * is read frame by frame here.
 *
 * That also removes the reconnect machinery `EventSource` brings: a run is not
 * resumable, so reconnection semantics would have been a second, wrong model of
 * what this endpoint does. Reading until the terminal event is simpler and is
 * the truth.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS TESTED, AND WHERE
 * ---------------------------------------------------------------------------
 *
 * Every decision in here is upstream of this component and lives in `runlog.ts`,
 * which is unit-tested: ordering by `seq`, replay idempotence, keeping steps on
 * failure, and refusing to revive a finished run. This file is a `map` and a
 * button. The one thing it does own — the frame decoder — is that same parser,
 * imported rather than reimplemented, because two parsers of the same protocol is
 * how a stream works in development and silently truncates on stage.
 */

import { useCallback, useRef, useState } from "react";
import {
  applyRunEvent,
  approveSummary,
  describeStep,
  emptyRunState,
  merchantLabel,
  parseRunEvent,
  statusLine,
  type RunProposal,
  type RunState,
} from "./runlog";
import { formatMinor } from "./format";

/** A `\n\n`-delimited chunk can split a UTF-8 sequence, so decode per frame. */
const decoder = new TextDecoder();

export function RunPanel() {
  const [state, setState] = useState<RunState>(emptyRunState);
  const abort = useRef<AbortController | null>(null);

  const running = state.phase === "running";

  /**
   * Re-read the read model after an approval.
   *
   * Not a poll: the figure changes when the merchant acts, and an action is
   * something they press. A poll here would show a stale hero number immediately
   * after a refund, which reads as a bug rather than as a race.
   */
  const refresh = useCallback(() => {
    void fetch("/api/state")
      .then((r) => r.json() as Promise<unknown>)
      .catch(() => undefined);
  }, []);

  const start = useCallback(async () => {
    if (abort.current !== null) return;
    const controller = new AbortController();
    abort.current = controller;
    setState(emptyRunState());

    try {
      const response = await fetch("/api/run", {
        method: "POST",
        headers: { accept: "text/event-stream" },
        signal: controller.signal,
      });

      // A 503 here is a sentence, not a stream: "OPENROUTER_API_KEY is not set".
      // Rendering it as a run failure would tell the presenter their agent broke
      // when their machine is simply not configured.
      if (!response.ok || response.body === null) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        setState({
          ...emptyRunState(),
          phase: "error",
          error: body.error ?? `The run could not start (${response.status}).`,
        });
        return;
      }

      const reader = response.body.getReader();
      let buffer = "";

      // Read to completion rather than breaking on the first `done`. The server
      // closes after the terminal event, and stopping early would leave the
      // connection open until the isolate is recycled.
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let split = buffer.indexOf("\n\n");
        while (split !== -1) {
          const frame = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          const event = parseRunEvent(frame);
          if (event !== null) {
            setState((previous) => applyRunEvent(previous, event));
          }
          split = buffer.indexOf("\n\n");
        }
      }
    } catch (error: unknown) {
      // An abort is the user's own doing and not a failure worth reporting.
      if (!controller.signal.aborted) {
        setState((previous) => ({
          ...previous,
          phase: "error",
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    } finally {
      abort.current = null;
    }
  }, []);

  return (
    <section className="log" aria-label="Agent run log">
      <div className="log__bar">
        <button className="action" type="button" onClick={() => void start()} disabled={running}>
          {running ? "Running…" : "Run the agent"}
        </button>
        <span className="log__status" role="status">
          {statusLine(state)}
        </span>
      </div>

      {state.steps.length > 0 && (
        <ol className="log__steps">
          {state.steps.map((step) => (
            <li className="log__step" key={step.seq} data-kind={step.kind}>
              <span className="log__seq">{step.seq}</span>
              <span className="log__label">{describeStep(step)}</span>
            </li>
          ))}
        </ol>
      )}

      {state.error !== null && <p className="log__error">{state.error}</p>}

      {state.finalText.length > 0 && <p className="log__final">{state.finalText}</p>}

      {state.proposals.length > 0 && (
        <Approve proposals={state.proposals} onDone={refresh} />
      )}
    </section>
  );
}

/**
 * The last click.
 *
 * ---------------------------------------------------------------------------
 * ONE BUTTON, NOT ONE PER PROPOSAL
 * ---------------------------------------------------------------------------
 *
 * The brief is "make the payment quickly", and a merchant who has read a plan is
 * approving that plan, not each line of it. The figure is on the button, so the
 * amount is visible *before* the click rather than after — which is the one place
 * a single-click design can still be honest about what it is about to do.
 *
 * The enforcement underneath is unchanged. `claimForExecution` is a conditional
 * update, so a second click loses the race and nothing is sent twice. Speed at
 * the surface, compare-and-set underneath.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT SHOWS WHEN THERE IS NO EXECUTOR
 * ---------------------------------------------------------------------------
 *
 * A Worker cannot spawn the MCP stdio server, so there is no PayPal executor here
 * and the request comes back a refusal. This renders that refusal as a sentence.
 * It does not optimistically show money recovered, and it does not hide the
 * failure — an "Approve" button that leaves the screen claiming nothing happened
 * is the exact shape of a product that lies about money.
 */
function Approve({
  proposals,
  onDone,
}: {
  readonly proposals: readonly RunProposal[];
  readonly onDone: () => void;
}) {
  const summary = approveSummary(proposals);
  const [busy, setBusy] = useState(false);
  const [outcomes, setOutcomes] = useState<{ ok: boolean; message: string }[] | null>(null);

  const approve = useCallback(async () => {
    const ids = proposals.filter((p) => p.status === "proposed").map((p) => p.id);
    if (ids.length === 0) return;
    setBusy(true);
    try {
      const response = await fetch("/api/actions/approve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ proposalIds: ids }),
      });
      const body = (await response.json()) as {
        outcomes?: { ok: boolean; message: string }[];
        error?: string;
      };
      setOutcomes(body.outcomes ?? [{ ok: false, message: body.error ?? "the request failed" }]);
      onDone();
    } catch (error: unknown) {
      setOutcomes([
        { ok: false, message: error instanceof Error ? error.message : String(error) },
      ]);
    } finally {
      setBusy(false);
    }
  }, [proposals, onDone]);

  return (
    <div className="approve">
      {proposals.map((proposal) => (
        <p className="approve__row" key={proposal.id}>
          <span className="approve__merchant">
            {merchantLabel(proposal.subId)}
            {/* The raw key, always. The label above is derived from it; this is
                what the data actually says, and no PayPal API returns a merchant
                name to anyone. */}
            <code className="approve__key">{proposal.subId}</code>
          </span>
          <span className="approve__amount">
            {proposal.amountCents === null
              ? "no money moves"
              : formatMinor(proposal.amountCents, proposal.currency)}
          </span>
          <span className="approve__why">{proposal.rationale}</span>
        </p>
      ))}

      {summary.available && outcomes === null && (
        <button className="action" type="button" onClick={() => void approve()} disabled={busy}>
          {busy
            ? "Approving…"
            : `Approve and refund ${formatMinor(summary.cents, summary.currency)}`}
        </button>
      )}

      {!summary.available && summary.count === 0 && proposals.length > 0 && (
        // Nothing refundable. A "$0.00" button would look broken, and a
        // cancellation genuinely does not move money.
        <p className="approve__note">
          Nothing here moves money — these are cancellations and questions, not refunds.
        </p>
      )}

      {outcomes !== null && (
        <ul className="approve__outcomes">
          {outcomes.map((outcome, i) => (
            <li key={i} data-ok={outcome.ok ? "true" : "false"}>
              {outcome.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}