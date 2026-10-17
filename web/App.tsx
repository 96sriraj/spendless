/**
 * The whole first screen, and nothing else.
 *
 * There is no router, no onboarding tour, and no second page. That is a
 * deliberate reading of the brief — "less interaction", "make the payment
 * quickly" — and it happens to align with what the product actually needs to
 * show: one number, one reason, one button, and the agent's reasoning beside it.
 *
 * ---------------------------------------------------------------------------
 * WHY THE AMOUNT ON SCREEN IS NOT COMPUTED HERE
 * ---------------------------------------------------------------------------
 *
 * `<MoneyFigure>` renders a value the API sent. It does not add, subtract,
 * convert or round anything. This is the boundary `AGENTS.md` draws — every
 * figure on screen traces to a pure function in the core — and a component that
 * recomputes a total is exactly how that claim quietly stops being true. The
 * value arrives already in minor units and is only ever *formatted*.
 */

import { useEffect, useState } from "react";
import { formatMinor } from "./format";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/app.css";

type Health = {
  readonly ok: boolean;
  readonly environment: "sandbox";
  readonly configured: { readonly paypal: boolean; readonly openrouter: boolean; readonly database: boolean };
};

/**
 * The SANDBOX badge. P6-04: visible on every screen that shows money or an
 * action.
 *
 * It states a **fact**, not a promise. `connectPayPalMcp` throws on anything but
 * `SANDBOX` before it will spawn a server, so the code below cannot reach live
 * money regardless of what the badge says. That is why this is worth putting on
 * screen at all: a badge that is merely decorative is worse than none, because
 * it invites a judge to check.
 */
function SandboxBadge({ health }: { readonly health: Health | null }) {
  const ready = health !== null && health.ok;

  return (
    <div
      // `role="status"` so it is announced once when the health check lands,
      // rather than every time the component re-renders.
      role="status"
      className="badge"
      data-ready={ready ? "true" : "false"}
    >
      <span className="badge__dot" aria-hidden="true" />
      <span className="badge__label">SANDBOX</span>
      <span className="badge__detail">
        {health === null
          ? "checking"
          : ready
            ? "no live money moves"
            : "unavailable"}
      </span>
    </div>
  );
}

/**
 * A money figure. Formats a number it was given and does nothing else.
 *
 * Split from `App` so it can be tested directly: this is the one component
 * where a mistake is worth real money, and a test that mounts the whole app to
 * check a formatter is a test nobody will read.
 */
export function MoneyFigure({
  cents,
  currency,
  tone,
}: {
  readonly cents: number;
  readonly currency: string;
  readonly tone: "risk" | "recovered" | "ink";
}) {
  return (
    <span className={`money money--${tone}`} data-testid="money-figure">
      {formatMinor(cents, currency)}
    </span>
  );
}

/**
 * Placeholder content until step 1 wires the real read path.
 *
 * The figure is 4,797 minor units, not 47,970. The first version of this file
 * had it ten times too high, and the only reason it was caught before anyone
 * else saw it is that the screenshot was actually looked at. Money figures do
 * not get reviewed by reading the code.
 */
const PLACEHOLDER_RISK_CENTS = 4_797;

export default function App() {
  const [health, setHealth] = useState<Health | null>(null);

  useEffect(() => {
    // One fetch on mount, no polling, no library. A health check that re-runs
    // every few seconds is a health check that will show a stale green while
    // something is on fire.
    let cancelled = false;

    void fetch("/api/health")
      .then((r) => r.json() as Promise<Health>)
      .then((body) => {
        if (!cancelled) setHealth(body);
      })
      .catch(() => {
        if (!cancelled) setHealth(null);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="app">
      <header className="bar">
        <span className="bar__mark">spendless</span>
        <SandboxBadge health={health} />
      </header>

      <main className="stage">
        {/* The number. Display step, tabular figures, nothing competing with it. */}
        <section className="hero">
          <MoneyFigure cents={PLACEHOLDER_RISK_CENTS} currency="USD" tone="risk" />
          <p className="hero__sub">wasted every month on subscriptions nobody is using</p>
          <p className="hero__note">
            The agent proposes. You decide. Nothing moves without you.
          </p>
        </section>
      </main>
    </div>
  );
}