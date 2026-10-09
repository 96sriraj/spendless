import { describe, expect, it } from "vitest";
import { getCancelGuide, listSupportedMerchants } from "./cancelGuide";

describe("cancelGuide — India merchants + aliases", () => {
  it("should resolve hotstar merchant directly", () => {
    const g = getCancelGuide("Hotstar");
    expect(g.key).toBe("hotstar");
    expect(g.url).toContain("hotstar.com");
  });
  it("should resolve jio cinema alias", () => {
    const g = getCancelGuide("JioCinema Premium");
    expect(g.key).toBe("jiocinema");
    expect(g.steps.length).toBeGreaterThanOrEqual(1);
  });
  it("should list includes core merchants netflix spotify adobe", () => {
    const list = listSupportedMerchants();
    expect(list).toContain("netflix");
    expect(list).toContain("spotify");
    expect(list).toContain("adobe_cc");
    expect(list).toContain("youtube_premium");
  });
  it("should alias hbo variations", () => {
    expect(getCancelGuide("HBO Max").key).toBe("hbo_max");
    expect(getCancelGuide("max").key).toBe("hbo_max");
    expect(getCancelGuide("hbo").key).toBe("hbo_max");
  });
  it("should alias prime video variations", () => {
    expect(getCancelGuide("Amazon Prime").key).toBe("prime_video");
    expect(getCancelGuide("prime video").key).toBe("prime_video");
  });
  it("should alias disney variations", () => {
    expect(getCancelGuide("Disney Plus").key).toBe("disney_plus");
    expect(getCancelGuide("disney+").key).toBe("disney_plus");
  });
  it("should alias apple music/icloud/google one", () => {
    expect(getCancelGuide("Apple Music").key).toBe("apple_music");
    expect(getCancelGuide("iCloud+").key).toBe("icloud");
    expect(getCancelGuide("Google One").key).toBe("google_one");
  });
  it("should fallback generic for unknown with correct url encoding", () => {
    const name = "MyIndian OTT 99";
    const g = getCancelGuide(name);
    expect(g.key).toBe("generic");
    expect(g.url).toContain(encodeURIComponent(name));
    expect(g.steps.join(" ")).toContain("Billing");
  });
  it("should substring match My Netflix Family", () => {
    expect(getCancelGuide("My Netflix Family Plan").key).toBe("netflix");
  });
  it("should notion and chatgpt aliases", () => {
    expect(getCancelGuide("Notion Plus").key).toBe("notion");
    expect(getCancelGuide("ChatGPT").key).toBe("chatgpt_plus");
    expect(getCancelGuide("OpenAI Plus").key).toBe("openai");
  });
});
