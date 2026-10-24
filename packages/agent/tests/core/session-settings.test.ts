import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, test } from "node:test";
import {
  applySessionSettings,
  DEFAULT_SESSION_SETTINGS,
  SETTINGS_META_KEY,
  sessionSettingsView,
  settingsFromMeta,
} from "../../src/core/agent/session-settings.js";

describe("session settings", () => {
  it("keeps the defaults when a client sends nothing or garbage", () => {
    for (const input of [undefined, null, "fast", [1, 2], {}]) {
      assert.deepEqual(applySessionSettings(DEFAULT_SESSION_SETTINGS, input), DEFAULT_SESSION_SETTINGS);
    }
    assert.deepEqual(settingsFromMeta(undefined), DEFAULT_SESSION_SETTINGS);
    assert.deepEqual(settingsFromMeta({ other: { memory: false } }), DEFAULT_SESSION_SETTINGS);
  });

  it("applies known keys, clamps numbers and ignores wrong types", () => {
    const settings = applySessionSettings(DEFAULT_SESSION_SETTINGS, {
      maxToolRounds: 1_000,
      autoCompact: "no",
      compactThreshold: 0.1,
      memory: false,
      commandTimeoutSeconds: 30.4,
      searxngUrl: " https://search.example/ ",
      unknown: true,
    });
    assert.deepEqual(settings, {
      maxToolRounds: 200,
      autoCompact: true,
      compactThreshold: 0.3,
      memory: false,
      commandTimeoutMs: 30_000,
      searxngUrl: "https://search.example/",
    });
    assert.equal(applySessionSettings(settings, { searxngUrl: "ftp://x" }).searxngUrl, "https://search.example/");
    assert.equal(applySessionSettings(settings, { searxngUrl: null }).searxngUrl, null);
    assert.equal(applySessionSettings(DEFAULT_SESSION_SETTINGS, { maxToolRounds: 0 }).maxToolRounds, 1);
    assert.equal(applySessionSettings(DEFAULT_SESSION_SETTINGS, { compactThreshold: 2 }).compactThreshold, 0.95);
    assert.equal(applySessionSettings(DEFAULT_SESSION_SETTINGS, { commandTimeoutSeconds: 1 }).commandTimeoutMs, 5_000);
    assert.equal(applySessionSettings(DEFAULT_SESSION_SETTINGS, { maxToolRounds: Number.NaN }).maxToolRounds, null);
  });

  it("merges over the current settings and reads them from _meta", () => {
    const first = settingsFromMeta({ [SETTINGS_META_KEY]: { autoCompact: false, maxToolRounds: 10 } });
    const next = applySessionSettings(first, { memory: false });
    assert.deepEqual(next, { ...DEFAULT_SESSION_SETTINGS, autoCompact: false, maxToolRounds: 10, memory: false });
    assert.equal(Object.isFrozen(DEFAULT_SESSION_SETTINGS), true);
  });

  it("shows the command timeout in seconds, as clients send it", () => {
    assert.deepEqual(sessionSettingsView({ ...DEFAULT_SESSION_SETTINGS, commandTimeoutMs: 45_000 }), {
      maxToolRounds: null,
      autoCompact: true,
      compactThreshold: null,
      memory: true,
      commandTimeoutSeconds: 45,
      searxngUrl: null,
    });
    assert.equal(sessionSettingsView(DEFAULT_SESSION_SETTINGS).commandTimeoutSeconds, null);
  });
});

test("a SearXNG server in the Nova settings is the default; a client's own wins", () => {
  const home = mkdtempSync(join(tmpdir(), "nova-searxng-"));
  try {
    writeFileSync(join(home, "settings.json"), JSON.stringify({ webSearch: { searxngUrl: "https://search.example.org" } }));
    assert.equal(settingsFromMeta(undefined, home).searxngUrl, "https://search.example.org");
    assert.equal(settingsFromMeta({ [SETTINGS_META_KEY]: { searxngUrl: "https://mine.example.org" } }, home).searxngUrl, "https://mine.example.org");
    assert.equal(settingsFromMeta({ [SETTINGS_META_KEY]: { searxngUrl: "" } }, home).searxngUrl, null);
    writeFileSync(join(home, "settings.json"), JSON.stringify({ webSearch: { searxngUrl: "file:///etc/passwd" } }));
    assert.equal(settingsFromMeta(undefined, home).searxngUrl, null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
