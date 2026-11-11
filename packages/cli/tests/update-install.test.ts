import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { globalNpmPrefix, parseUpdateAnswer, withInstallability } from "../src/update-install.js";

test("Enter or y updates, s skips the version, anything else is 'not today'", () => {
  assert.equal(parseUpdateAnswer(""), "update");
  assert.equal(parseUpdateAnswer(" Y "), "update");
  assert.equal(parseUpdateAnswer("yes"), "update");
  assert.equal(parseUpdateAnswer("s"), "skip");
  assert.equal(parseUpdateAnswer("skip"), "skip");
  assert.equal(parseUpdateAnswer("n"), "later");
  assert.equal(parseUpdateAnswer("whatever"), "later");
});

/** npm's global layout: <prefix>/lib/node_modules/<pkg> and <prefix>/bin/nova-ai (Windows: <prefix>/node_modules, <prefix>/nova-ai.cmd). */
function globalInstall(windows: boolean, withBin = true): { prefix: string; script: string } {
  const prefix = mkdtempSync(join(tmpdir(), "nova-npm-prefix-"));
  const dist = join(prefix, ...(windows ? [] : ["lib"]), "node_modules", "@datalabrotterdam", "nova-ai-cli", "dist");
  mkdirSync(dist, { recursive: true });
  const script = join(dist, "index.js");
  writeFileSync(script, "");
  if (withBin) {
    if (windows) writeFileSync(join(prefix, "nova-ai.cmd"), "");
    else {
      mkdirSync(join(prefix, "bin"));
      writeFileSync(join(prefix, "bin", "nova-ai"), "");
    }
  }
  return { prefix, script };
}

test("the npm prefix is found for a global install only", () => {
  const platform = process.platform;
  const windows = platform === "win32";
  const { prefix, script } = globalInstall(windows);
  assert.equal(globalNpmPrefix({ scriptPath: script, platform }), realpathSync(prefix));

  const unlinked = globalInstall(windows, false);
  assert.equal(globalNpmPrefix({ scriptPath: unlinked.script, platform }), null, "no global bin link");

  const project = mkdtempSync(join(tmpdir(), "nova-project-"));
  const dependency = join(project, "node_modules", "@datalabrotterdam", "nova-ai-cli", "dist");
  mkdirSync(dependency, { recursive: true });
  writeFileSync(join(dependency, "index.js"), "");
  if (!windows) {
    assert.equal(globalNpmPrefix({ scriptPath: join(dependency, "index.js"), platform }), null, "project dependency");
  }

  const source = join(mkdtempSync(join(tmpdir(), "nova-src-")), "index.ts");
  writeFileSync(source, "");
  assert.equal(globalNpmPrefix({ scriptPath: source, platform }), null, "source checkout");
});

test("npm's bin link resolves to the package", (t) => {
  if (process.platform === "win32") return t.skip("npm uses .cmd shims on Windows");
  const { prefix, script } = globalInstall(false);
  const bin = join(mkdtempSync(join(tmpdir(), "nova-npm-bin-")), "nova-ai");
  symlinkSync(script, bin);
  assert.equal(globalNpmPrefix({ scriptPath: bin }), realpathSync(prefix));
});

test("a found update is marked installable or not; no update stays null", async () => {
  const { script } = globalInstall(process.platform === "win32");
  const update = { currentVersion: "1.0.0", latestVersion: "1.1.0", tag: "latest", command: "npm install -g x" };
  assert.equal((await withInstallability(update, { scriptPath: script }))?.installable, true);
  const source = join(mkdtempSync(join(tmpdir(), "nova-src-")), "index.ts");
  writeFileSync(source, "");
  assert.equal((await withInstallability(update, { scriptPath: source }))?.installable, false);
  assert.equal(await withInstallability(null), null);
});
