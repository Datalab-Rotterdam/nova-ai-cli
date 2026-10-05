import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import {
  browserSetupDisabled,
  bundledInstaller,
  describeBrowserSetup,
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

test("finds the vendored host from the package's src/ (and dist/)", () => {
  // npm runs the tests in packages/cli.
  assert.match(bundledInstaller(join(process.cwd(), "src")) ?? "", /browser-host[/\\]dist[/\\]cli\.js$/);
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
