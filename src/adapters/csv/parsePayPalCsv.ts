/**
 * CSV account adapter - binding C, the consumer narrative.
 *
 * A PayPal activity export is the *only* PayPal surface that names the payee.
 * A merchant reading its own Transaction Search data never sees a merchant
 * name (ARCHITECTURE.md section 11a), and a buyer has no consumer-side API at
 * all - but a buyer can download a CSV, and that CSV says "Netflix" on the
 * row. So this adapter is where the lifted detector graph gets a real merchant
 * identity, and it is the reason the consumer story is worth keeping.
 *
 * READ-ONLY BY DESIGN. There is no write path and there will not be one: a
 * consumer export cannot be used to move money, and pretending otherwise is the
 * exact mistake ARCHITECTURE.md section 2 exists to prevent.
 */

import {
  UnsupportedCapabilityError,
  type AccountCapabilities,
  type AccountSource,
  type DateRange,
  type RawDispute,
  type RawSubscription,
  type RawTransaction,
  type TransactionStatus,
} from "../AccountSource";
import { DEFAULT_CURRENCY, type Currency } from "@/core/validators";

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/**
 * One RFC 4180 record. Written by hand rather than pulled in as a dependency:
 * it is ~20 lines, the export format is stable, and a parser dependency would
 * be more supply chain than this needs.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let sawAnyChar = false;

  // A UTF-8 BOM survives .txt round-trips and corrupts the first header cell.
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    sawAnyChar = true;

    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && input[i + 1] === "\n") i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return sawAnyChar ? rows : [];
}

// ---------------------------------------------------------------------------
// Column mapping
// ---------------------------------------------------------------------------

const REQUIRED_COLUMNS = ["Date", "Name", "Currency", "Transaction ID"] as const;

type Columns = Record<(typeof REQUIRED_COLUMNS)[number], number> & {
  time: number;
  type: number;
  status: number;
  gross: number;
};

function findHeader(rows: readonly string[][]): { header: string[]; index: number } {
  for (let i = 0; i < rows.length; i += 1) {
    const candidate = rows[i] ?? [];
    const hasAll = REQUIRED_COLUMNS.every((c) => candidate.includes(c));
    if (hasAll) return { header: candidate, index: i };
  }
  throw new Error(
    `Not a PayPal activity export: no header row containing ${REQUIRED_COLUMNS.join(", ")}.`,
  );
}

function indexColumns(header: readonly string[]): Columns {
  const at = (name: string): number => header.indexOf(name);
  return {
    Date: at("Date"),
    Name: at("Name"),
    Currency: at("Currency"),
    "Transaction ID": at("Transaction ID"),
    time: at("Time"),
    type: at("Type"),
    status: at("Status"),
    gross: at("Gross"),
  };
}

const STATUS_MAP: Record<string, TransactionStatus> = {
  completed: "settled",
  pending: "pending",
  denied: "denied",
  refunded: "reversed",
  reversed: "reversed",
  cancelled: "denied",
  refunded_: "reversed",
};

/**
 * Parse a decimal money string into integer minor units.
 *
 * Returns null rather than NaN: a row we cannot read is dropped, and a NaN
 * amount that slipped through would become a finding with a nonsense saving.
 */
export function parseAmountToCents(raw: string): number | null {
  const trimmed = raw.trim().replace(/[$£€\s]/g, "");
  if (trimmed.length === 0) return null;
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) return null;
  const negative = trimmed.startsWith("-");
  const [whole, fraction = ""] = (negative ? trimmed.slice(1) : trimmed).split(".");
  const minorUnits = (fraction.slice(0, 2) + "00").slice(0, 2);
  const cents = Number(whole ?? "0") * 100 + Number(minorUnits);
  if (!Number.isFinite(cents)) return null;
  return negative ? -cents : cents;
}

/**
 * Which way round the day and month are in a PayPal export.
 *
 * PayPal localises its exports: US accounts get MM/DD/YYYY, most of the rest
 * of the world gets DD/MM/YYYY. Guessing wrong does not throw - it silently
 * swaps every month, which moves every renewal window and makes the product
 * confidently wrong rather than obviously broken. So the order is *detected
 * from the data*, and when the data cannot settle it the parse refuses.
 */
type DateOrder = "DMY" | "MDY";

function detectDateOrder(rawDates: readonly string[]): DateOrder | null {
  let firstAboveTwelve = 0;
  let secondAboveTwelve = 0;

  for (const raw of rawDates) {
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(raw.trim());
    if (m === null) continue;
    const first = Number(m[1]);
    const second = Number(m[2]);
    if (first > 12) firstAboveTwelve += 1;
    if (second > 12) secondAboveTwelve += 1;
  }

  if (firstAboveTwelve > 0 && secondAboveTwelve === 0) return "DMY";
  if (secondAboveTwelve > 0 && firstAboveTwelve === 0) return "MDY";
  return null;
}

function parseCapturedAt(
  date: string,
  time: string | undefined,
  order: DateOrder,
): string | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(date.trim());
  if (m === null) return null;

  const [, first, second, year] = m;
  const day = order === "DMY" ? first : second;
  const month = order === "DMY" ? second : first;
  if (day === undefined || month === undefined || year === undefined) return null;

  const [h, min, sec] = (time ?? "00:00:00").split(":");
  // The TimeZone column in a real export is often just the label "UTC", which
  // carries no offset. Treated as UTC, and stated rather than assumed quietly.
  const iso = `${year}-${month}-${day}T${h ?? "00"}:${min ?? "00"}:${sec ?? "00"}.000Z`;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

function mapCurrency(raw: string): Currency {
  const code = raw.trim().toUpperCase();
  return code === "INR" ? "INR" : DEFAULT_CURRENCY;
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export function createCsvAccountSource(text: string): AccountSource {
  const rows = parseCsv(text);
  const { header, index } = findHeader(rows);
  const cols = indexColumns(header);

  // Date order is settled across the whole file before a single row is read,
  // because one row alone is often ambiguous.
  const dateOrder = detectDateOrder(
    rows.slice(index + 1).map((r) => (cols.Date >= 0 ? (r[cols.Date] ?? "") : "")),
  );
  if (dateOrder === null) {
    throw new Error(
      "Could not determine the date format in this PayPal export: no day above 12 " +
        "appears in either position, so MM/DD/YYYY and DD/MM/YYYY are indistinguishable. " +
        "Refusing to guess - a wrong guess silently shifts every transaction.",
    );
  }

  const parsed: RawTransaction[] = [];
  for (let i = index + 1; i < rows.length; i += 1) {
    const row = rows[i];
    if (row === undefined) continue;

    const cell = (at: number): string => (at >= 0 ? (row[at] ?? "").trim() : "");

    const id = cell(cols["Transaction ID"]);
    const capturedAt = parseCapturedAt(cell(cols.Date), cell(cols.time), dateOrder);
    if (id.length === 0 || capturedAt === null) continue;

    const type = cell(cols.type);
    const isRefund = type.toLowerCase().startsWith("refund");

    // Amounts are reported as a positive magnitude, matching PayPal's own REST
    // schema. Direction lives in `status` and `subject`. The core compares
    // amounts and ranks findings by them; a stray negative would quietly
    // invert every ranking.
    const rawCents = parseAmountToCents(cell(cols.gross));
    if (rawCents === null) continue;
    const amountCents = Math.abs(rawCents);

    // A refund row can arrive with status "Completed" - the refund itself
    // completed. What matters to the reader is that money came back, so the
    // type is checked first.
    const status = isRefund ? "reversed" : (STATUS_MAP[cell(cols.status).toLowerCase()] ?? "settled");

    parsed.push({
      id,
      merchantKey: cell(cols.Name) || "unknown",
      identitySource: cell(cols.Name).length > 0 ? "csv_payee" : "unknown",
      amountCents,
      currency: mapCurrency(cell(cols.Currency)),
      capturedAt,
      eventCode: "",
      status,
      subject: type.length > 0 ? type : null,
      raw: Object.fromEntries(header.map((h, at) => [h, row[at] ?? ""])),
    });
  }

  const CAPABILITIES: AccountCapabilities = {
    listTransactions: true,
    listSubscriptions: false,
    listDisputes: false,
    refund: false,
    cancelSubscription: false,
    resolveDispute: false,
  };

  const refuse = (capability: string, reason: string): never => {
    throw new UnsupportedCapabilityError(capability, "csv", reason);
  };

  return {
    kind: "csv",

    async capabilities(): Promise<AccountCapabilities> {
      return CAPABILITIES;
    },

    async listTransactions(range: DateRange): Promise<RawTransaction[]> {
      const start = range.start.getTime();
      const end = range.end.getTime();
      return parsed.filter((t) => {
        const at = Date.parse(t.capturedAt);
        return at >= start && at <= end;
      });
    },

    async listSubscriptions(): Promise<RawSubscription[]> {
      return refuse("list subscriptions", "an activity export has no plan objects");
    },

    async listDisputes(): Promise<RawDispute[]> {
      return refuse("list disputes", "an activity export has no dispute objects");
    },
  };
}