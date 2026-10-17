import { describe, expect, it } from "vitest";
import { readMcpToolResult } from "./mcpEnvelope";

/**
 * The MCP server returns a tool result as an envelope, not as data:
 *
 *   { content: [{ type: "text", text: "<the actual JSON, as a string>" }] }
 *
 * So the payload every tool returns is a JSON *string* nested inside JSON. That
 * is the only genuinely fiddly part of talking to the server, and getting it
 * wrong fails quietly — an unparsed envelope parses to `undefined`, an undefined
 * transaction list is an empty account, and an empty account looks exactly like
 * a fresh sandbox.
 *
 * That last step is the one that matters. Every other decision in this project
 * has been about not letting "we could not read it" masquerade as "there was
 * nothing there".
 */

const envelope = (payload: unknown, isError = false) => ({
  content: [{ type: "text", text: JSON.stringify(payload) }],
  isError,
});

describe("readMcpToolResult", () => {
  it("should parse the JSON string an MCP text block carries", () => {
    const body = { transaction_details: [{ transaction_info: { transaction_id: "T1" } }] };

    expect(readMcpToolResult(envelope(body))).toEqual(body);
  });

  it("should surface a tool-reported error instead of returning empty", () => {
    // The server signalling failure in-band, with HTTP 200. Read naively this is
    // indistinguishable from "no transactions", and the account would look
    // empty rather than broken.
    const failed = {
      content: [{ type: "text", text: "UNAUTHORISED: invalid credentials" }],
      isError: true,
    };

    expect(() => readMcpToolResult(failed)).toThrow(/UNAUTHORISED/);
  });

  it("should surface the error even when the error body is valid JSON", () => {
    // A structured error is the more dangerous shape, because it survives JSON
    // parsing and looks like data.
    const failed = envelope({ error: "invalid_client", message: "bad creds" }, true);

    expect(() => readMcpToolResult(failed)).toThrow(/invalid_client|bad creds/);
  });

  it("should skip non-text content blocks rather than failing on them", () => {
    // Servers are allowed to attach images or resources alongside the payload.
    // Keying off blocks[0] would break the moment one appeared first.
    const body = { items: [] };

    expect(
      readMcpToolResult({
        content: [
          { type: "image", data: "base64...", mimeType: "image/png" },
          { type: "text", text: JSON.stringify(body) },
        ],
        isError: false,
      }),
    ).toEqual(body);
  });

  it("should fail loudly when there is no text block at all", () => {
    expect(() =>
      readMcpToolResult({ content: [{ type: "image", data: "x" }], isError: false }),
    ).toThrow(/no text/i);
  });

  it("should fail loudly when the text block is not JSON", () => {
    // Returning the raw string would let it flow into the parser as a
    // transaction list and quietly produce zero transactions.
    expect(() => readMcpToolResult({ content: [{ type: "text", text: "OK" }] })).toThrow(
      /JSON/i,
    );
  });

  it("should surface an API-level failure the server reports as a successful call", () => {
    // RED on a live result, 2026-10-17. PayPal's server does not use the MCP
    // `isError` channel for HTTP failures. It returns the error *inside* a
    // normal, successful tool result:
    //
    //   { ok: false, status: 422, code: "PAYPAL_API_HTTP_ERROR",
    //     message: "The capture has already been fully refunded" }
    //
    // This is the second, quieter failure channel, and it is the dangerous
    // shape — valid JSON that looks exactly like data. Left alone it produced
    // two real bugs: a failed `list_transactions` read as **zero
    // transactions** (an empty account, indistinguishable from a fresh sandbox),
    // and a failed `cancel_subscription` read as **succeeded**, because "we got
    // here" was the success test.
    const failure = {
      ok: false,
      status: 422,
      code: "PAYPAL_API_HTTP_ERROR",
      message:
        "The requested action could not be performed, semantically incorrect, or " +
        "failed business validation.: The capture has already been fully refunded",
    };

    expect(() => readMcpToolResult(envelope(failure), "create_refund")).toThrow(
      /already been fully refunded/i,
    );
  });

  it("should name the tool that failed, so a silent refund cannot masquerade", () => {
    const failure = { ok: false, status: 403, message: "PERMISSION_DENIED" };
    expect(() => readMcpToolResult(envelope(failure), "cancel_subscription")).toThrow(
      /cancel_subscription/,
    );
  });

  it("should keep an explicit ok:true result as data", () => {
    // The counterpart to the test above, and the reason the check is `ok === false`
    // rather than "does this object have a `message`". A PayPal payload can carry
    // a message field of its own without being an error.
    const body = { ok: true, id: "1JU", status: "COMPLETED" };
    expect(readMcpToolResult(envelope(body))).toEqual(body);
  });

  it("should not mistake a PayPal payload's own fields for an error envelope", () => {
    // `status` and `message` both appear in legitimate PayPal objects. Only the
    // explicit `ok: false` marks the wrapper, so a refund object carrying
    // `status: "COMPLETED"` is never read as a failure.
    const refund = {
      id: "1JU",
      status: "COMPLETED",
      amount: { currency_code: "USD", value: "15.99" },
      message: "Refund completed",
    };
    expect(readMcpToolResult(envelope(refund))).toEqual(refund);
  });

  it("should reject a result that is not an MCP envelope at all", () => {
    expect(() => readMcpToolResult(null)).toThrow();
    expect(() => readMcpToolResult({ nope: true })).toThrow(/content/i);
    expect(() => readMcpToolResult({ content: [] })).toThrow(/no text/i);
  });

  it("should report which tool failed, because the caller has several", () => {
    expect(() => readMcpToolResult({ content: [{ type: "text", text: "boom" }], isError: true }, "list_disputes")).toThrow(
      /list_disputes/,
    );
  });

  it("should keep a null body as null rather than treating it as an error", () => {
    // Some tools answer with a JSON `null`. That is a real, parseable answer,
    // and turning it into a thrown error would be its own kind of lie.
    expect(readMcpToolResult(envelope(null))).toBeNull();
  });
});
