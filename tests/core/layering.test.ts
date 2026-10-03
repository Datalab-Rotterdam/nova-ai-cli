import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Compiled to dist-test/tests/core, so the repo root is three levels up.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const srcRoot = join(repoRoot, "src");

/** Layers that src/core must never depend on: core is shared by every front end. */
const FORBIDDEN_FROM_CORE = ["acp", "tui", "headless", "webui"];

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return tsFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

test("src/core does not import from acp, tui, headless or webui", () => {
  const violations: string[] = [];
  for (const file of tsFiles(join(srcRoot, "core"))) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/(?:from|import)\s*\(?\s*"(\.{1,2}\/[^"]+)"/g)) {
      const target = resolve(dirname(file), match[1]!);
      const layer = relative(srcRoot, target).split(sep)[0];
      if (layer && FORBIDDEN_FROM_CORE.includes(layer)) {
        violations.push(`${relative(repoRoot, file)} -> ${match[1]}`);
      }
    }
  }
  assert.deepEqual(violations, []);
});
