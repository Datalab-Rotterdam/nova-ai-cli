import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  browserSetupDisabled,
  bundledInstaller,
  describeBrowserSetup,
  hostLaunch,
  INSTALLER_ARGS,
  installBrowserSkill,
  installerArgs,
  parseSetupOutput,
  runBrowserHost,
  setUpBrowser,
} from "../src/browser-setup.js";

const result = {
  version: "0.1.0",
  usedThisVersion: true,
  changed: true,
  browsers: ["Microsoft Edge"],
  newBrowsers: ["Microsoft Edge"],
  node: "/usr/local/bin/node",
  skills: [],
};

function tempDir(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), "nova-browser-setup-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("finds the installer of the host package", () => {
  assert.match(bundledInstaller() ?? "", /nova-ai-browser-host[/\\]dist[/\\]cli\.js$/);
});

test("installed with npm, this Node runs the host installer in auto mode, then the skill is installed", async () => {
  const calls: string[] = [];
  const launch = hostLaunch("/x/browser-host/dist/cli.js", false, "/usr/bin/node");
  const got = await setUpBrowser(
    async (command, args) => {
      calls.push([command, ...args].join(" "));
      return `a warning\n${JSON.stringify(result)}\n`;
    },
    launch,
    async () => calls.push("skill"),
  );
  assert.deepEqual(got, result);
  assert.deepEqual(calls, ["/usr/bin/node /x/browser-host/dist/cli.js install --auto --json", "skill"]);
  assert.deepEqual(INSTALLER_ARGS, ["install", "--auto", "--json"]);
});

test("the binary carries the host itself: no Node needed", () => {
  const launch = hostLaunch("/cache/browser-host/dist/cli.js", true, "/usr/local/bin/nova-ai")!;
  assert.deepEqual(launch, { command: "/usr/local/bin/nova-ai", args: ["browser-host"], carrier: true });
  assert.deepEqual(installerArgs(launch), [
    "browser-host",
    "install",
    "--auto",
    "--json",
    "--carrier",
    "/usr/local/bin/nova-ai",
    "--carrier-arg",
    "browser-host",
  ]);
});

test("a failed registration installs no skill", async () => {
  let skill = false;
  await assert.rejects(
    setUpBrowser(async () => {
      throw new Error("no");
    }, hostLaunch("/x/cli.js", false), async () => (skill = true)),
  );
  assert.equal(skill, false);
});

test("installs the nova-browser skill read-only from nova-ai-skills", async (t) => {
  const home = tempDir(t);
  assert.equal(await installBrowserSkill(home), true);
  const folder = join(home, "skills", "nova-browser");
  assert.equal(JSON.parse(readFileSync(join(folder, ".nova-bundled.json"), "utf8")).bundledBy, "Nova AI Skills");
  if (process.platform !== "win32") assert.equal(statSync(join(folder, "SKILL.md")).mode & 0o222, 0);
  // Current: nothing to write.
  assert.equal(await installBrowserSkill(home), false);
});

test("browser-host runs the host's command line with its own arguments", async (t) => {
  const dir = tempDir(t);
  const out = join(dir, "argv.json");
  const script = join(dir, "cli.mjs");
  writeFileSync(script, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(2)));\n`);
  const argv = [...process.argv];
  try {
    await runBrowserHost(["chrome-extension://abc/", "--parent-window=0"], script);
  } finally {
    process.argv.splice(0, process.argv.length, ...argv);
  }
  assert.ok(existsSync(out));
  assert.deepEqual(JSON.parse(readFileSync(out, "utf8")), ["chrome-extension://abc/", "--parent-window=0"]);
});

test("is off in CI and on request", () => {
  assert.equal(browserSetupDisabled({}), false);
  assert.equal(browserSetupDisabled({ CI: "true" }), true);
  assert.equal(browserSetupDisabled({ NOVA_AI_BROWSER_AUTO_SETUP: "0" }), true);
});

test("explains a first-time registration", () => {
  assert.match(describeBrowserSetup(result), /Restart Microsoft Edge once/);
  assert.throws(() => parseSetupOutput("nothing"), /no result/);
});
