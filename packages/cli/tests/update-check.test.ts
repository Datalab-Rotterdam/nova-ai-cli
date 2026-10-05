import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  checkForUpdate,
  chooseUpdate,
  formatUpdateNotice,
  isNewerVersion,
  readInstalledVersion,
  rememberUpdateAnswer,
  shouldAskAboutUpdate,
  updateChecksDisabled,
} from "../src/update-check.js";

// GitHub Actions sets CI, which turns the check off; tests pass their own env.
const ENV = {};
const npm =
  (tags: Record<string, string>, onRequest?: (url: string, init?: RequestInit) => void) =>
  async (input: string | URL | Request, init?: RequestInit) => {
    onRequest?.(String(input), init);
    return new Response(JSON.stringify(tags), { status: 200, headers: { "content-type": "application/json" } });
  };

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

test("a stable install follows latest; a pre-release install also its own channel", () => {
  const tags = { latest: "1.1.0", alpha: "1.2.0-alpha.3" };
  assert.deepEqual(chooseUpdate("1.0.1", tags), {
    currentVersion: "1.0.1",
    latestVersion: "1.1.0",
    tag: "latest",
    command: "npm install -g @datalabrotterdam/nova-ai-cli@latest",
  });
  assert.equal(chooseUpdate("1.1.0", tags), null, "stable users are not pushed onto alpha");
  assert.equal(chooseUpdate("1.2.0-alpha.2", tags)?.command, "npm install -g @datalabrotterdam/nova-ai-cli@alpha");
  assert.equal(chooseUpdate("1.2.0-alpha.2", tags)?.latestVersion, "1.2.0-alpha.3");
  // Once the stable release is out it is newer than every alpha of it.
  assert.equal(
    chooseUpdate("1.2.0-alpha.3", { latest: "1.2.0", alpha: "1.2.0-alpha.3" })?.command,
    "npm install -g @datalabrotterdam/nova-ai-cli@latest",
  );
  assert.equal(chooseUpdate("1.2.0-alpha.3", tags), null);
});

test("update check asks npm's dist-tags with a timeout", async () => {
  let requested = "";
  let signal: AbortSignal | null | undefined;
  const update = await checkForUpdate({
    currentVersion: "1.1.0",
    cachePath: null,
    env: ENV,
    fetchImpl: npm({ latest: "1.2.0" }, (url, init) => {
      requested = url;
      signal = init?.signal;
    }),
  });
  assert.match(requested, /registry\.npmjs\.org\/-\/package\/@datalabrotterdam%2Fnova-ai-cli\/dist-tags$/);
  assert.ok(signal);
  assert.equal(update?.latestVersion, "1.2.0");
  assert.equal(
    formatUpdateNotice(update!),
    "Update available: nova-ai 1.1.0 → 1.2.0. Run: npm install -g @datalabrotterdam/nova-ai-cli@latest",
  );
});

test("npm is asked at most once a day", async () => {
  const cachePath = join(mkdtempSync(join(tmpdir(), "nova-update-")), "update-check.json");
  let requests = 0;
  const fetchImpl = npm({ latest: "1.2.0" }, () => requests++);
  const day = 24 * 60 * 60 * 1_000;

  await checkForUpdate({ currentVersion: "1.1.0", cachePath, env: ENV, fetchImpl, now: () => 1_000 });
  const cached = await checkForUpdate({ currentVersion: "1.1.0", cachePath, env: ENV, fetchImpl, now: () => 1_000 + day - 1 });
  assert.equal(requests, 1, "the second run uses the cached answer");
  assert.equal(cached?.latestVersion, "1.2.0");
  assert.deepEqual(JSON.parse(readFileSync(cachePath, "utf8")), { checkedAt: 1_000, distTags: { latest: "1.2.0" } });

  await checkForUpdate({ currentVersion: "1.1.0", cachePath, env: ENV, fetchImpl, now: () => 1_000 + day });
  assert.equal(requests, 2, "a day later npm is asked again");

  writeFileSync(cachePath, "not json");
  await checkForUpdate({ currentVersion: "1.1.0", cachePath, env: ENV, fetchImpl, now: () => 5_000 });
  assert.equal(requests, 3, "a broken cache is ignored");
});

test("update check stays silent when current, offline, cancelled or switched off", async () => {
  const base = { cachePath: null, env: ENV } as const;
  assert.equal(await checkForUpdate({ ...base, currentVersion: "1.2.0", fetchImpl: npm({ latest: "1.2.0" }) }), null);
  assert.equal(
    await checkForUpdate({
      ...base,
      currentVersion: "1.1.0",
      fetchImpl: async () => {
        throw new Error("offline");
      },
    }),
    null,
  );
  const abort = new AbortController();
  abort.abort();
  assert.equal(
    await checkForUpdate({
      ...base,
      currentVersion: "1.1.0",
      signal: abort.signal,
      fetchImpl: async (_input, init) => {
        init?.signal?.throwIfAborted();
        return new Response("{}");
      },
    }),
    null,
  );
  let asked = false;
  for (const env of [{ CI: "true" }, { NOVA_NO_UPDATE_CHECK: "1" }, { NO_UPDATE_NOTIFIER: "1" }]) {
    assert.equal(updateChecksDisabled(env), true);
    assert.equal(
      await checkForUpdate({
        ...base,
        env,
        currentVersion: "1.1.0",
        fetchImpl: npm({ latest: "9.0.0" }, () => (asked = true)),
      }),
      null,
    );
  }
  assert.equal(asked, false, "switched off means no request at all");
});

test("the start-up prompt remembers 'not today' for a day and 'skip' for that version only", async () => {
  const cachePath = join(mkdtempSync(join(tmpdir(), "nova-update-")), "update-check.json");
  const day = 24 * 60 * 60 * 1_000;
  const update = chooseUpdate("1.0.0", { latest: "1.1.0" })!;
  assert.equal(shouldAskAboutUpdate(update, { cachePath, now: () => 0 }), true, "asked without a cache");

  rememberUpdateAnswer("later", update, { cachePath, now: () => 1_000 });
  assert.equal(shouldAskAboutUpdate(update, { cachePath, now: () => 1_000 + day - 1 }), false);
  assert.equal(shouldAskAboutUpdate(update, { cachePath, now: () => 1_000 + day }), true);

  rememberUpdateAnswer("skip", update, { cachePath, now: () => 2_000 });
  assert.equal(shouldAskAboutUpdate(update, { cachePath, now: () => 2_000 + 10 * day }), false);
  const newer = chooseUpdate("1.0.0", { latest: "1.2.0" })!;
  assert.equal(shouldAskAboutUpdate(newer, { cachePath, now: () => 2_000 }), true, "a newer version is asked about");

  // A daily npm refresh keeps the answer.
  await checkForUpdate({ currentVersion: "1.0.0", cachePath, env: ENV, fetchImpl: npm({ latest: "1.1.0" }), now: () => 3 * day });
  assert.equal(JSON.parse(readFileSync(cachePath, "utf8")).skippedVersion, "1.1.0");
  assert.equal(shouldAskAboutUpdate(update, { cachePath, now: () => 3 * day }), false);
});
