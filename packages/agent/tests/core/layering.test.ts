import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/** packages/agent, found by walking up from the compiled test. */
function packageRoot(): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const manifest = join(directory, "package.json");
    if (existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf8")).name === "@datalabrotterdam/nova-ai-agent") {
      return directory;
    }
    const parent = dirname(directory);
    if (parent === directory) throw new Error("packages/agent not found");
    directory = parent;
  }
}

const root = packageRoot();
const srcRoot = join(root, "src");

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "web" ? [] : tsFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

function specifiers(file: string): string[] {
  const source = readFileSync(file, "utf8");
  return [...source.matchAll(/(?:from|import)\s*\(?\s*"([^"]+)"/g)].map((match) => match[1]!);
}

test("core does not import from acp, client or commands", () => {
  const violations: string[] = [];
  for (const file of tsFiles(join(srcRoot, "core"))) {
    for (const specifier of specifiers(file)) {
      if (!specifier.startsWith(".")) continue;
      const layer = relative(srcRoot, resolve(dirname(file), specifier)).split(sep)[0];
      if (layer && ["acp", "client", "commands"].includes(layer)) {
        violations.push(`${relative(root, file)} -> ${specifier}`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test("the agent package never pulls in the CLI or UI libraries", () => {
  const violations: string[] = [];
  for (const file of tsFiles(srcRoot)) {
    for (const specifier of specifiers(file)) {
      const outsidePackage =
        specifier.startsWith(".") && !resolve(dirname(file), specifier).startsWith(root + sep);
      if (
        outsidePackage ||
        specifier.startsWith("@datalabrotterdam/nova-ai-cli") ||
        ["ink", "react", "marked", "chalk", "cli-highlight"].includes(specifier.split("/")[0]!)
      ) {
        violations.push(`${relative(root, file)} -> ${specifier}`);
      }
    }
  }
  assert.deepEqual(violations, []);
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.deepEqual(
    Object.keys(manifest.dependencies ?? {}).filter((name) => ["ink", "react"].includes(name)),
    [],
  );
});

test("the suite runs against a throwaway home directory", async () => {
  const { homedir } = await import("node:os");
  assert.ok(process.env.NOVA_TEST_HOME, "tests must be started with --import setup-env");
  assert.equal(homedir(), process.env.NOVA_TEST_HOME);
});
