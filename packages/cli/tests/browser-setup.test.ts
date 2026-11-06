import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import {
  BrowserNeedsNodeError,
  browserSetupDisabled,
  bundledInstaller,
  describeBrowserSetup,
  findNode,
  INSTALLER_ARGS,
  parseSetupOutput,
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

test("finds the installer of the host package", () => {
  assert.match(bundledInstaller() ?? "", /nova-ai-browser-host[/\\]dist[/\\]cli\.js$/);
});

test("runs the host installer in auto mode with this Node", async () => {
  let call: { node: string; args: string[] } | undefined;
  const got = await setUpBrowser(async (node, args) => {
    call = { node, args };
    return `a warning\n${JSON.stringify(result)}\n`;
  }, "/x/browser-host/dist/cli.js");
  assert.deepEqual(got, result);
  assert.equal(call?.node, process.execPath);
  assert.deepEqual(call?.args, ["/x/browser-host/dist/cli.js", ...INSTALLER_ARGS]);
  assert.deepEqual(INSTALLER_ARGS, ["install", "--auto", "--json"]);
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

const NODE = process.platform === "win32" ? "node.exe" : "node";

function pathWithNodes(t: { after(fn: () => void): void }, ...names: string[]): string[] {
  const root = mkdtempSync(join(tmpdir(), "nova-find-node-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return names.map((name) => {
    const dir = join(root, name);
    mkdirSync(dir);
    writeFileSync(join(dir, NODE), "");
    return dir;
  });
}

test("takes the first Node on PATH that is new enough", async (t) => {
  const [old, current, newer] = pathWithNodes(t, "old", "current", "newer");
  const versions = new Map([[join(old!, NODE), "v18.20.0\n"], [join(current!, NODE), "v20.0.0\n"], [join(newer!, NODE), "v24.1.0\n"]]);
  const found = await findNode({ PATH: [old, current, newer].join(delimiter) }, async (path) => versions.get(path) ?? "");
  assert.equal(found, join(current!, NODE));
});

test("never runs a Node from the current folder through a relative or empty PATH entry", async (t) => {
  const asked: string[] = [];
  const [cwd] = pathWithNodes(t, "cwd");
  const before = process.cwd();
  t.after(() => process.chdir(before));
  process.chdir(cwd!);
  const found = await findNode({ PATH: ["", ".", "bin"].join(delimiter) }, async (path) => {
    asked.push(path);
    return "v24.0.0\n";
  });
  assert.equal(found, undefined);
  assert.deepEqual(asked, []);
});

test("skips a Node that does not run", async (t) => {
  const [broken] = pathWithNodes(t, "broken");
  const found = await findNode({ PATH: broken }, async () => {
    throw new Error("cannot execute");
  });
  assert.equal(found, undefined);
});

test("without a Node the installer does not run, and the reason is reported", async () => {
  await assert.rejects(
    setUpBrowser(async () => assert.fail("must not run"), "/x/cli.js", async () => undefined),
    BrowserNeedsNodeError,
  );
});
