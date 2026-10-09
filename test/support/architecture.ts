/**
 * Architecture gate scanner.
 *
 * AGENTS.md states three rules as conventions. This turns them into things
 * that fail. It lives in test/ because it is test infrastructure, not product
 * code - and it is itself tested (see architecture.test.ts), so a broken
 * scanner cannot silently pass the repo.
 */

export type Violation = {
  readonly rule: string;
  readonly file: string;
  readonly line: number;
  readonly text: string;
};

export type SourceFile = {
  /** Repo-relative, forward-slash separated, e.g. "src/core/money.ts". */
  readonly path: string;
  readonly content: string;
};

const SRC_PREFIX = "src/";
const ADAPTER_LAYER_PREFIX = "src/adapters/";
const CORE_PREFIX = "src/core/";

/**
 * Imports no module above the adapter layer is allowed to make. This is the
 * entire risk hedge: if MCP turns out to cover everything, the other adapters
 * can be deleted and nothing above them moves.
 */
export const BANNED_ABOVE_ADAPTERS: readonly string[] = [
  "openai",
  "@paypal/agent-toolkit",
  "node:fs",
];

/** Mocking primitives forbidden inside the deterministic core. */
export const MOCK_PRIMITIVES: readonly string[] = [
  "vi.mock",
  "vi.fn",
  "vi.spyOn",
  "vi.useFakeTimers",
];

export const TS_SUPPRESSIONS: readonly string[] = [
  "as any",
  "@ts-ignore",
  "@ts-expect-error",
];

/** A suppression is tolerated only when a justification sits next to it. */
export const JUSTIFICATION_MARKER = "justification:";

export type Import = {
  readonly specifier: string;
  readonly offset: number;
};

const IMPORT_PATTERNS: readonly RegExp[] = [
  /\bfrom\s*["']([^"']+)["']/g,
  /\bimport\s*["']([^"']+)["']/g,
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
];

function lineOf(content: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < content.length; i += 1) {
    if (content[i] === "\n") line += 1;
  }
  return line;
}

/** Every module specifier a file imports, from ESM, dynamic import or require. */
export function importsOf(content: string): Import[] {
  const out: Import[] = [];
  for (const pattern of IMPORT_PATTERNS) {
    for (const match of content.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier !== undefined && match.index !== undefined) {
        out.push({ specifier, offset: match.index });
      }
    }
  }
  return out.sort((a, b) => a.offset - b.offset);
}

/**
 * A suppression is tolerated only when a justification sits adjacent to it -
 * the same line, or within two lines either side. Comments conventionally go
 * above the offending line, so looking forward only would be wrong.
 */
export function hasJustification(
  lines: readonly string[],
  lineIndex: number,
): boolean {
  const first = Math.max(0, lineIndex - 2);
  const last = Math.min(lineIndex + 2, lines.length - 1);
  for (let i = first; i <= last; i += 1) {
    if ((lines[i] ?? "").includes(JUSTIFICATION_MARKER)) return true;
  }
  return false;
}

export function scan(files: readonly SourceFile[]): Violation[] {
  const violations: Violation[] = [];

  for (const file of files) {
    const filePath = file.path.replace(/\\/g, "/");
    const lines = file.content.split("\n");
    const isSource = filePath.startsWith(SRC_PREFIX);
    const inAdapters = filePath.startsWith(ADAPTER_LAYER_PREFIX);
    const inCore = filePath.startsWith(CORE_PREFIX);

    // Rule 1: the adapter-layer import ban. Only src/ is governed.
    if (isSource && !inAdapters) {
      for (const found of importsOf(file.content)) {
        if (BANNED_ABOVE_ADAPTERS.includes(found.specifier)) {
          violations.push({
            rule: "no-banned-import-above-adapters",
            file: filePath,
            line: lineOf(file.content, found.offset),
            text:
              `imports "${found.specifier}" - only src/adapters/ may do this ` +
              `(AGENTS.md, ports and adapters)`,
          });
        }
      }
    }

    // Rule 2: the deterministic core is pure by construction.
    if (inCore) {
      for (const primitive of MOCK_PRIMITIVES) {
        const needle = `${primitive}(`;
        let at = file.content.indexOf(needle);
        while (at >= 0) {
          violations.push({
            rule: "no-mocks-in-core",
            file: filePath,
            line: lineOf(file.content, at),
            text:
              `uses ${primitive}() in the deterministic core - fix the boundary, ` +
              `do not mock (AGENTS.md)`,
          });
          at = file.content.indexOf(needle, at + needle.length);
        }
      }
    }

    // Rule 3: no silent type escapes anywhere in src/.
    if (isSource) {
      for (const suppression of TS_SUPPRESSIONS) {
        let at = file.content.indexOf(suppression);
        while (at >= 0) {
          const lineIndex = lineOf(file.content, at) - 1;
          if (!hasJustification(lines, lineIndex)) {
            violations.push({
              rule: "no-unjustified-ts-suppression",
              file: filePath,
              line: lineIndex + 1,
              text:
                `"${suppression}" without a "${JUSTIFICATION_MARKER}" comment ` +
                `within two lines of it`,
            });
          }
          at = file.content.indexOf(suppression, at + suppression.length);
        }
      }
    }
  }

  return violations;
}

export function formatViolations(violations: readonly Violation[]): string {
  return violations
    .map((v) => `  ${v.rule}  ${v.file}:${v.line}\n    ${v.text}`)
    .join("\n");
}