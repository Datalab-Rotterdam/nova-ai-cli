import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { configureStandalone, runtimeCacheRoot, standalone, standaloneSkillSource, unpackAssets } from "../../src/core/standalone.js";
import { AGENT_PACKAGE_NAME, readPackageVersion } from "../../src/core/version.js";

const archiveOf = (files: Record<string, string>) =>
  gzipSync(
    JSON.stringify(Object.fromEntries(Object.entries(files).map(([path, text]) => [path, Buffer.from(text).toString("base64")]))),
  ).toString("base64");

function tempCache(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), "nova-standalone-"));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return dir;
}

test("unpacks nested files, and leaves no temp folder", (t) => {
  const cache = tempCache(t);
  const dir = unpackAssets(archiveOf({ "a.txt": "one", "b/c/d.txt": "two" }), cache);
  assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "one");
  assert.equal(readFileSync(join(dir, "b", "c", "d.txt"), "utf8"), "two");
  assert.deepEqual(readdirSync(join(cache, "runtime")).filter((entry) => entry.startsWith(".")), []);
});

test("keeps an unpacked copy on later starts", (t) => {
  const cache = tempCache(t);
  const archive = archiveOf({ "a.txt": "one" });
  const dir = unpackAssets(archive, cache);
  writeFileSync(join(dir, "marker"), "");
  assert.equal(unpackAssets(archive, cache), dir);
  assert.ok(existsSync(join(dir, "marker")));
});

test("removes what another version unpacked, but no running unpack", (t) => {
  const cache = tempCache(t);
  const old = unpackAssets(archiveOf({ "a.txt": "old" }), cache);
  const running = join(cache, "runtime", ".tmp-running");
  mkdirSync(running);
  const current = unpackAssets(archiveOf({ "a.txt": "new" }), cache);
  assert.notEqual(current, old);
  assert.equal(existsSync(old), false);
  assert.ok(existsSync(running));
});

test("a broken archive throws and leaves nothing behind", (t) => {
  const cache = tempCache(t);
  assert.throws(() => unpackAssets(Buffer.from("not gzip").toString("base64"), cache));
  assert.deepEqual(readdirSync(join(cache, "runtime")), []);
});

test("uses each platform's cache folder", () => {
  assert.equal(runtimeCacheRoot({}, "darwin", "/h"), join("/h", "Library", "Caches", "nova-ai"));
  assert.equal(runtimeCacheRoot({}, "linux", "/h"), join("/h", ".cache", "nova-ai"));
  assert.equal(runtimeCacheRoot({ XDG_CACHE_HOME: "/xdg" }, "linux", "/h"), join("/xdg", "nova-ai"));
  assert.equal(runtimeCacheRoot({ LOCALAPPDATA: "/local" }, "win32", "/h"), join("/local", "nova-ai", "cache"));
  assert.equal(runtimeCacheRoot({}, "win32", "/h"), join("/h", "AppData", "Local", "nova-ai", "cache"));
});

test("ignores a relative XDG_CACHE_HOME, as the XDG spec requires", () => {
  assert.equal(runtimeCacheRoot({ XDG_CACHE_HOME: "cache" }, "linux", "/h"), join("/h", ".cache", "nova-ai"));
});

test("versions come from package.json outside a binary and from the build inside one", (t) => {
  assert.equal(standalone(), null);
  assert.equal(standaloneSkillSource(), undefined);
  assert.notEqual(readPackageVersion(), "9.9.9");
  t.after(() => configureStandalone(null));
  configureStandalone({ versions: { [AGENT_PACKAGE_NAME]: "9.9.9" }, skillsVersion: "1.0.0", archive: "" });
  assert.equal(readPackageVersion(), "9.9.9");
  assert.equal(readPackageVersion("@example/other"), null);
});
