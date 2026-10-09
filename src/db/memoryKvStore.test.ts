import { describe, expect, it } from "vitest";
import { createMemoryKvStore } from "./memoryKvStore";

describe("memoryKvStore", () => {
  it("round-trips a value", async () => {
    const store = createMemoryKvStore();
    await store.kvSet("a", "1");
    expect(await store.kvGet("a")).toBe("1");
  });

  it("returns null for a key that was never written", async () => {
    expect(await createMemoryKvStore().kvGet("nope")).toBeNull();
  });

  it("treats an empty string as a real value, not as absent", async () => {
    // The lifted parsers branch on null, so "" must survive as "".
    const store = createMemoryKvStore();
    await store.kvSet("empty", "");
    expect(await store.kvGet("empty")).toBe("");
  });

  it("is last-write-wins, which is what recordUsage assumes", async () => {
    const store = createMemoryKvStore();
    await store.kvSet("usage:sub-1", "2026-01-01T00:00:00.000Z");
    await store.kvSet("usage:sub-1", "2026-02-01T00:00:00.000Z");
    expect(await store.kvGet("usage:sub-1")).toBe("2026-02-01T00:00:00.000Z");
  });

  it("removes a key and leaves it absent", async () => {
    const store = createMemoryKvStore();
    await store.kvSet("a", "1");
    await store.kvRemove("a");
    expect(await store.kvGet("a")).toBeNull();
  });

  it("removing an absent key is a no-op", async () => {
    await expect(createMemoryKvStore().kvRemove("absent")).resolves.toBeUndefined();
  });

  it("accepts a seed without sharing state between stores", async () => {
    const seeded = createMemoryKvStore({ a: "1" });
    const empty = createMemoryKvStore();
    expect(await seeded.kvGet("a")).toBe("1");
    expect(await empty.kvGet("a")).toBeNull();

    await seeded.kvSet("b", "2");
    expect(await empty.kvGet("b")).toBeNull();
  });

  it("preserves values containing SQL-looking text, because a merchant name is arbitrary", async () => {
    const store = createMemoryKvStore();
    const nasty = `'; DROP TABLE subscriptions; --`;
    await store.kvSet("merchant", nasty);
    expect(await store.kvGet("merchant")).toBe(nasty);
  });
});