import { describe, expect, it } from "vitest";
import {
  BRAND_COLORS,
  BRAND_NAME,
  BRAND_TAGLINE,
  pageTitle,
  SHORT_BRAND_NAME,
} from "./brand";

// Lifted from nixt and adapted: this is spendless, not a Nixt rebrand. The
// App Store ID, bundle id and store-review deep link are gone because the
// README locks the platform to web-first - there is no app to deep link into,
// and a brand file that exports someone else's ids is a lie waiting to ship.
describe("brand — constants", () => {
  it("should expose the short wordmark", () => {
    expect(SHORT_BRAND_NAME).toBe("spendless");
  });

  it("should expose a display brand name that starts with the wordmark", () => {
    expect(BRAND_NAME.startsWith(SHORT_BRAND_NAME)).toBe(true);
    expect(BRAND_NAME.length).toBeGreaterThan(SHORT_BRAND_NAME.length);
  });

  it("should not leak the sibling project's name into spendless's brand", () => {
    expect(BRAND_NAME).not.toMatch(/nixt/i);
    expect(SHORT_BRAND_NAME).not.toMatch(/nixt/i);
    expect(BRAND_TAGLINE).not.toMatch(/nixt/i);
  });

  it("should carry the one-line positioning the README leads with", () => {
    expect(BRAND_TAGLINE.toLowerCase()).toContain("spends less");
  });

  it("should expose brand colors with a hex primary and background", () => {
    expect(BRAND_COLORS.primary).toMatch(/^#[0-9a-fA-F]{6}$/);
    expect(BRAND_COLORS.background).toMatch(/^#[0-9a-fA-F]{6}$/);
  });
});

describe("brand — pageTitle", () => {
  it("should suffix a page name with the short wordmark", () => {
    expect(pageTitle("Dashboard")).toBe("Dashboard — spendless");
  });

  it("should handle an empty page name without leaving a dangling separator", () => {
    expect(pageTitle("")).toBe(SHORT_BRAND_NAME);
    expect(pageTitle("   ")).toBe(SHORT_BRAND_NAME);
  });

  it("should always end with the short brand name", () => {
    for (const page of ["Findings", "Action review", "Replay"]) {
      expect(pageTitle(page).endsWith(SHORT_BRAND_NAME)).toBe(true);
    }
  });

  it("should not double the separator", () => {
    expect(pageTitle("")).not.toMatch(/—/);
    expect(pageTitle("Dashboard")).not.toMatch(/—\s*—/);
  });
});