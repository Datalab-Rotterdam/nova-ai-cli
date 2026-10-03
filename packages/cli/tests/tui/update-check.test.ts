import assert from "node:assert/strict";
import test from "node:test";
import {
  checkForUpdate,
  isNewerVersion,
  readInstalledVersion,
  UPDATE_COMMAND,
} from "../../src/tui/update-check.js";

test("installed version is read from the package metadata", () => {
  assert.match(readInstalledVersion() ?? "", /^\d+\.\d+\.\d+/);
});

test("semantic version comparison only accepts newer releases", () => {
  assert.equal(isNewerVersion("1.2.0", "1.1.9"), true);
  assert.equal(isNewerVersion("2.0.0", "1.99.99"), true);
  assert.equal(isNewerVersion("1.1.0", "1.1.0"), false);
  assert.equal(isNewerVersion("1.0.9", "1.1.0"), false);
  assert.equal(isNewerVersion("1.1.0", "1.1.0-beta.1"), true);
  assert.equal(isNewerVersion("1.1.0-beta.2", "1.1.0-beta.1"), true);
  assert.equal(isNewerVersion("not-a-version", "1.1.0"), false);
});

test("update check returns the latest npm version and upgrade command", async () => {
  let requestedUrl = "";
  const update = await checkForUpdate({
    currentVersion: "1.1.0",
    fetchImpl: async (input, init) => {
      requestedUrl = String(input);
      assert.ok(init?.signal);
      return new Response(JSON.stringify({ version: "1.2.0" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  assert.match(
    requestedUrl,
    /registry\.npmjs\.org\/@datalabrotterdam%2Fnova-ai-cli\/latest$/,
  );
  assert.deepEqual(update, {
    currentVersion: "1.1.0",
    latestVersion: "1.2.0",
    command: UPDATE_COMMAND,
  });
});

test("update check stays silent for current versions and registry failures", async () => {
  assert.equal(
    await checkForUpdate({
      currentVersion: "1.2.0",
      fetchImpl: async () =>
        new Response(JSON.stringify({ version: "1.2.0" }), { status: 200 }),
    }),
    null,
  );
  assert.equal(
    await checkForUpdate({
      currentVersion: "1.1.0",
      fetchImpl: async () => {
        throw new Error("offline");
      },
    }),
    null,
  );
});
