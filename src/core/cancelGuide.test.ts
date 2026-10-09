import { describe, expect, it } from "vitest";
import { getCancelGuide, listSupportedMerchants } from "./cancelGuide";

describe("cancelGuide — known merchant", () => {
  it("should return Netflix steps for 'netflix'", () => {
    const g = getCancelGuide("netflix");
    expect(g.key).toBe("netflix");
    expect(g.steps.length).toBeGreaterThanOrEqual(1);
    expect(g.url).toContain("netflix.com");
  });

  it("should be case-insensitive and trim", () => {
    const g = getCancelGuide("  Netflix  ");
    expect(g.key).toBe("netflix");
  });

  it("should resolve alias 'youtube premium' -> youtube_premium", () => {
    const g = getCancelGuide("YouTube Premium");
    expect(g.key).toBe("youtube_premium");
    expect(g.url).toContain("youtube.com");
  });

  it("should resolve alias 'chatgpt plus' via substring and exact", () => {
    const exact = getCancelGuide("chatgpt plus");
    expect(exact.key).toBe("chatgpt_plus");
    const withPrefix = getCancelGuide("My ChatGPT Plus Family");
    expect(withPrefix.key).toBe("chatgpt_plus");
  });

  it("should resolve spotify and adobe aliases", () => {
    expect(getCancelGuide("Spotify").key).toBe("spotify");
    expect(getCancelGuide("adobe cc").key).toBe("adobe_cc");
  });

  it("should list supported merchants non-empty", () => {
    const list = listSupportedMerchants();
    expect(list.length).toBeGreaterThan(5);
    expect(list).toContain("netflix");
  });
});

describe("cancelGuide — unknown fallback", () => {
  it("should return generic guide for unknown merchant", () => {
    const g = getCancelGuide("Acme Unknown Sub 999");
    expect(g.key).toBe("generic");
    expect(g.steps.length).toBeGreaterThanOrEqual(1);
    expect(g.url).toContain("google.com/search");
    expect(g.displayName).toBe("Acme Unknown Sub 999");
  });

  it("should return generic for empty/whitespace input", () => {
    const g = getCancelGuide("   ");
    expect(g.key).toBe("generic");
    expect(g.displayName).toBe("Subscription");
  });

  it("should include search query with merchant name in generic url", () => {
    const g = getCancelGuide("MyRandomService");
    expect(g.url).toContain(encodeURIComponent("MyRandomService"));
  });
});
