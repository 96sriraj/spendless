import { describe, expect, it } from "vitest";
import { readSeedMarker, seedMarker, SEED_MARKER_PREFIX } from "./seedMarker";

/**
 * Reading the one identity carrier that actually survives a PayPal round trip.
 *
 * Measured live on 2026-10-17, and the result decided this module's existence:
 *
 *   `invoice_id`      → empty in Transaction Search
 *   `custom_field`    → empty in Transaction Search
 *   `transaction_subject` → "Netflix monthly plan"  ← survived
 *
 * Orders v2 does not propagate the first two into the reporting API, even though
 * `invoice_id` is documented as merchant-sent. So `transaction_subject` is the
 * only field available, and it carries `purchase_units[].description`.
 *
 * Which means the identity we need must be written into that description. It
 * cannot be a human-readable string we parse back, because parsing "Netflix
 * monthly plan" into the key `sub-netflix` is a lookup table wearing a
 * disguise, and it breaks the moment a merchant's name is ambiguous.
 *
 * So the description carries an explicit, namespaced marker instead. That makes
 * trust *derivable* rather than assumed, which is what lets it sit in
 * `TRUSTWORTHY_IDENTITY` at all.
 */

describe("seedMarker", () => {
  it("should round-trip a key through a marker", () => {
    expect(readSeedMarker(seedMarker("sub-netflix"))).toBe("sub-netflix");
  });

  it("should not treat an arbitrary merchant description as ours", () => {
    // The live counter-example. PayPal populates transaction_subject on its own
    // system rows, and a consumer's export will carry whatever the merchant
    // typed. Neither is seed-authored, so neither may key a detector.
    expect(readSeedMarker("Initial balance")).toBeNull();
    expect(readSeedMarker("Netflix monthly plan")).toBeNull();
    expect(readSeedMarker("ADOBE *CREATIVECLOUD 4087745673")).toBeNull();
  });

  it("should reject a marker with no key after the prefix", () => {
    expect(readSeedMarker(SEED_MARKER_PREFIX)).toBeNull();
    expect(readSeedMarker(`${SEED_MARKER_PREFIX}   `)).toBeNull();
  });

  it("should reject a key containing characters that would break a lookup", () => {
    // The key becomes a group-by key in recurrence.ts and a route param in the
    // run log. A colon or a newline in there is a bug waiting to be found.
    expect(readSeedMarker(`${SEED_MARKER_PREFIX}a:b`)).toBeNull();
    expect(readSeedMarker(`${SEED_MARKER_PREFIX}a\nb`)).toBeNull();
  });

  it("should tolerate a description with trailing human text after the marker", () => {
    // The description is also shown to a human, so it may read
    // "spendless:sub-netflix — Netflix monthly plan". The key is the first
    // token; the rest is presentation.
    expect(readSeedMarker(`${SEED_MARKER_PREFIX}sub-adobe — Adobe monthly plan`)).toBe(
      "sub-adobe",
    );
  });

  it("should not match a prefix that merely starts the same way", () => {
    expect(readSeedMarker("spendlessXsub-netflix")).toBeNull();
  });

  it("should handle a null or empty subject without throwing", () => {
    // `transaction_subject` is optional on a real transaction, and the adapter
    // passes null straight through.
    expect(readSeedMarker(null)).toBeNull();
    expect(readSeedMarker(undefined)).toBeNull();
    expect(readSeedMarker("")).toBeNull();
  });

  it("should preserve a key with dots and dashes, which the seed really uses", () => {
    expect(readSeedMarker(seedMarker("sub-creative-cloud.v2"))).toBe("sub-creative-cloud.v2");
  });
});
