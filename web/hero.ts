/**
 * What the headline is allowed to claim.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A MODULE AND NOT PART OF `App.tsx`
 * ---------------------------------------------------------------------------
 *
 * `App.tsx` fetches a response and puts it on screen. There is no logic in that
 * worth a DOM, a renderer and two new dev dependencies three weeks before a
 * submission. The logic is *here*: which tone, which currency, whether a number
 * may be shown at all, and what the screen has to admit about where the money
 * came from.
 *
 * Every one of those is a way the first screen could state something false while
 * looking entirely correct. A merchant shown a confident figure that means
 * nothing is worse off than one shown a blank page, so the refusals are the
 * feature:
 *
 * - a total that spans currencies is **not rendered**, because `buildReadModel`
 *   withholds it and rendering it anyway turns "I cannot tell you" into "you have
 *   nothing to lose";
 * - a seeded-history figure is **labelled as history**, because D5's middle lane
 *   is ours and it is not a payment PayPal reported;
 * - an unbound database is **a setup state**, not a reassuring zero.
 *
 * ---------------------------------------------------------------------------
 * NO ARITHMETIC HAPPENS HERE
 * ---------------------------------------------------------------------------
 *
 * `cents` is whatever the server computed. This module formats and chooses, and
 * never sums, scales or rounds a money figure. That boundary is what
 * `AGENTS.md` means by "every figure on screen traces to a pure function in the
 * core".
 */

export type Lane = "live_sandbox" | "seeded_history" | "csv";

export type StateResponse = {
  readonly generatedAt: string | null;
  readonly totalRiskCents: number;
  readonly currency: string | null;
  readonly findings: readonly {
    readonly kind: string;
    readonly subId: string;
    readonly title: string;
    readonly subtitle: string;
    readonly savingCents: number;
    readonly cta: string;
    readonly confidence: string;
    readonly lane: Lane;
  }[];
  readonly subscriptions: readonly { readonly id: string }[];
  readonly lanes: readonly Lane[];
  readonly transactionCount: number;
  readonly database: boolean;
};

export type HeroFigure = {
  /** Major units are never computed here — minor units, verbatim from the API. */
  readonly cents: number;
  readonly currency: string;
  readonly tone: "risk" | "recovered" | "ink";
  /** The sentence above the number. Says what is true, including when that is "nothing". */
  readonly headline: string;
  /** Where the money came from. Null when nothing has been read. */
  readonly provenance: string | null;
  /** False when no number may be shown — mixed currencies, or still loading. */
  readonly totalled: boolean;
  readonly loading: boolean;
};

/**
 * Human labels for D5's lanes.
 *
 * Written out rather than derived from the enum, because the strings are shown
 * to a merchant and `seeded_history` reads like a database table to anyone who
 * has not read `ARCHITECTURE.md`.
 */
const LANE_LABEL: Record<Lane, string> = {
  live_sandbox: "live sandbox",
  seeded_history: "seeded history",
  csv: "csv import",
};

export function heroFigure(state: StateResponse | null): HeroFigure {
  if (state === null) {
    return {
      cents: 0,
      currency: "USD",
      tone: "ink",
      headline: "Reading your account…",
      provenance: null,
      totalled: false,
      loading: true,
    };
  }

  const provenance = describeLanes(state.lanes);

  // An unbound database is a configuration state. Rendering "$0 at risk" off the
  // back of it is the single most reassuring thing this screen could do while
  // being completely wrong.
  if (!state.database) {
    return {
      cents: 0,
      currency: "USD",
      tone: "ink",
      headline: "No database connected — link the account to see your figures",
      provenance: null,
      totalled: false,
      loading: false,
    };
  }

  // The server withholds the total across currencies rather than adding euros to
  // dollars. Honouring that is the whole point of it withholding it.
  if (state.currency === null) {
    return {
      cents: 0,
      currency: "USD",
      tone: "ink",
      headline: "Cannot total these figures — they span more than one currency",
      provenance,
      totalled: false,
      loading: false,
    };
  }

  if (state.totalRiskCents <= 0) {
    return {
      cents: 0,
      currency: state.currency,
      tone: "ink",
      headline: "Nothing at risk right now",
      provenance,
      totalled: true,
      loading: false,
    };
  }

  return {
    cents: state.totalRiskCents,
    currency: state.currency,
    tone: "risk",
    headline: "at risk every month",
    provenance,
    totalled: true,
    loading: false,
  };
}

/**
 * Name every lane that contributed.
 *
 * All of them, never the most flattering one. A model seeded with history *and*
 * holding live captures has to say both, because "live sandbox" alone would hide
 * that part of the figure is ours.
 */
function describeLanes(lanes: readonly Lane[]): string | null {
  if (lanes.length === 0) return null;
  const labels = lanes.map((lane) => LANE_LABEL[lane]);
  return labels.length === 1 ? labels[0]! : labels.join(" + ");
}