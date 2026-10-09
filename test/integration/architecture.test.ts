/**
 * The architecture gates, as tests.
 *
 * Part 1 is self-verification: the scanner is tested against synthetic
 * violations, so a scanner that quietly stops detecting anything fails here
 * rather than waving the real repo through.
 *
 * Part 2 runs the scanner over the actual repository.
 */

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
  formatViolations,
  importsOf,
  scan,
  type SourceFile,
  type Violation,
} from "../support/architecture";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const SOURCE_DIRS = ["src"];
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts"]);

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) {
      continue;
    }
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (SOURCE_EXTENSIONS.has(path.extname(entry))) {
      out.push(full);
    }
  }
  return out;
}

function repoSources(): SourceFile[] {
  const files: SourceFile[] = [];
  for (const dir of SOURCE_DIRS) {
    for (const full of walk(path.join(REPO_ROOT, dir))) {
      files.push({
        path: path.relative(REPO_ROOT, full).replace(/\\/g, "/"),
        content: readFileSync(full, "utf8"),
      });
    }
  }
  return files;
}

function rules(violations: readonly Violation[]): string[] {
  return [...new Set(violations.map((v) => v.rule))].sort();
}

describe("architecture scanner - self-verification", () => {
  it("finds every import syntax, including dynamic and require", () => {
    const specifiers = importsOf(
      [
        'import { z } from "zod";',
        "import type { A } from '@/core/a';",
        'const b = await import("./b.js");',
        'const c = require("node:path");',
      ].join("\n"),
    ).map((i) => i.specifier);

    expect(specifiers).toEqual(
      expect.arrayContaining(["zod", "@/core/a", "./b.js", "node:path"]),
    );
  });

  it("flags a banned import above the adapter layer", () => {
    const violations = scan([
      { path: "src/core/leak.ts", content: 'import OpenAI from "openai";\n' },
    ]);
    expect(rules(violations)).toEqual(["no-banned-import-above-adapters"]);
    expect(violations[0]?.file).toBe("src/core/leak.ts");
    expect(violations[0]?.line).toBe(1);
  });

  it("flags node:fs and the agent toolkit the same way", () => {
    for (const specifier of ["node:fs", "@paypal/agent-toolkit"]) {
      const violations = scan([
        { path: "src/agent/x.ts", content: `import x from "${specifier}";\n` },
      ]);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.rule).toBe("no-banned-import-above-adapters");
    }
  });

  it("permits the banned imports inside src/adapters, which is the point of the seam", () => {
    const violations = scan([
      {
        path: "src/adapters/csv/parse.ts",
        content: 'import { readFileSync } from "node:fs";\n',
      },
    ]);
    expect(violations).toEqual([]);
  });

  it("does not govern test files or scripts", () => {
    const violations = scan([
      { path: "test/integration/db.ts", content: 'import fs from "node:fs";\n' },
      { path: "scripts/seed.ts", content: 'import OpenAI from "openai";\n' },
    ]);
    expect(violations).toEqual([]);
  });

  it("flags every mock primitive in the core", () => {
    for (const primitive of ["vi.mock", "vi.fn", "vi.spyOn", "vi.useFakeTimers"]) {
      const violations = scan([
        { path: "src/core/money.test.ts", content: `${primitive}("./x");\n` },
      ]);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.rule).toBe("no-mocks-in-core");
    }
  });

  it("allows mocks outside the core, where they belong", () => {
    const violations = scan([
      { path: "src/agent/tools.test.ts", content: 'vi.mock("./x");\n' },
    ]);
    expect(violations).toEqual([]);
  });

  it("flags an unjustified type suppression and accepts a justified one", () => {
    const bad = scan([
      { path: "src/db/index.ts", content: "const x = y as any;\n" },
    ]);
    expect(bad).toHaveLength(1);
    expect(bad[0]?.rule).toBe("no-unjustified-ts-suppression");

    const good = scan([
      {
        path: "src/db/index.ts",
        content:
          "// justification: D1 row shapes are validated by zod before use\n" +
          "const x = y as any;\n",
      },
    ]);
    expect(good).toEqual([]);
  });

  it("recognises the justification marker only near the suppression", () => {
    const violations = scan([
      {
        path: "src/db/index.ts",
        content: [
          "// justification: a long unrelated comment far above",
          "",
          "",
          "",
          "const x = y as any;",
          "",
        ].join("\n"),
      },
    ]);
    expect(violations).toHaveLength(1);
  });

  it("accepts a justification written on the line above, the usual idiom", () => {
    const above = scan([
      {
        path: "src/db/index.ts",
        content: "// justification: D1 row shape is validated by zod\nconst x = y as any;\n",
      },
    ]);
    expect(above).toEqual([]);

    const below = scan([
      {
        path: "src/db/index.ts",
        content: "const x = y as any; // justification: D1 row shape\n",
      },
    ]);
    expect(below).toEqual([]);
  });

  it("reports every occurrence, not just the first", () => {
    const violations = scan([
      {
        path: "src/db/index.ts",
        content: "const a = b as any;\nconst c = d as any;\nconst e = f as any;\n",
      },
    ]);
    expect(violations).toHaveLength(3);
  });

  it("reads code, not the prose about it", () => {
    // A doc comment naming vi.mock() documents the ban; it is not a violation.
    const violations = scan([
      {
        path: "src/core/dates.ts",
        content: [
          "/**",
          " * Nixt's version used vi.useFakeTimers() in its tests, which the",
          " * architecture gate forbids here.",
          " */",
          "export const MS_PER_DAY = 86400000;",
          "",
        ].join("\n"),
      },
    ]);
    expect(violations).toEqual([]);
  });

  it("still catches a violation that follows a comment on the same line", () => {
    const violations = scan([
      {
        path: "src/core/x.ts",
        content: "/* header */ import OpenAI from 'openai';\n",
      },
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.line).toBe(1);
  });

  it("does not treat a // inside a string as the start of a comment", () => {
    const violations = scan([
      {
        path: "src/core/brand.ts",
        content: 'export const URL = "https://example.com"; // vi.mock()\n',
      },
    ]);
    expect(violations).toEqual([]);
  });
});

describe("architecture gates - this repository", () => {
  const violations = scan(repoSources());

  it("has no banned imports above the adapter layer", () => {
    const found = violations.filter(
      (v) => v.rule === "no-banned-import-above-adapters",
    );
    expect(found, formatViolations(found)).toEqual([]);
  });

  it("keeps the deterministic core free of mocks", () => {
    const found = violations.filter((v) => v.rule === "no-mocks-in-core");
    expect(found, formatViolations(found)).toEqual([]);
  });

  it("has no unjustified type suppressions", () => {
    const found = violations.filter(
      (v) => v.rule === "no-unjustified-ts-suppression",
    );
    expect(found, formatViolations(found)).toEqual([]);
  });
});