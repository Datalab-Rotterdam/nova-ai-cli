import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assetName,
  binaryInstallable,
  checksumFor,
  installBinaryUpdate,
  releasePage,
  removeReplacedBinary,
  swapBinary,
  UpdateNotReadyError,
} from "../src/update-binary.js";

const ASSET = "nova-ai-linux-x64.tar.gz";
const NEW_VERSION = "2.0.0";
// Unpacking and running a fake binary use a POSIX shell; the swap itself is tested on its own below.
const posixOnly = { skip: process.platform === "win32" };

function tempDir(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), "nova-update-binary-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function installed(t: { after(fn: () => void): void }): { dir: string; target: string } {
  const dir = join(tempDir(t), "bin");
  mkdirSync(dir);
  const target = join(dir, "nova-ai");
  writeFileSync(target, "the old binary");
  chmodSync(target, 0o751);
  return { dir, target };
}

/** A release archive holding a script that reports `reports`. */
function archiveWith(t: { after(fn: () => void): void }, reports: string, file = "nova-ai"): Buffer {
  const dir = tempDir(t);
  writeFileSync(join(dir, file), `#!/bin/sh\necho "${reports}"\n`);
  writeFileSync(join(dir, "LICENSE"), "license");
  const archive = join(dir, "out.tar.gz");
  execFileSync("tar", ["-czf", archive, "-C", dir, file, "LICENSE"]);
  return readFileSync(archive);
}

const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");

function fakeRelease(files: Record<string, Buffer | string>) {
  const asked: string[] = [];
  const fetchImpl = async (url: string) => {
    asked.push(url);
    const file = decodeURIComponent(url.slice(url.lastIndexOf("/") + 1));
    const body = files[file];
    return body === undefined ? new Response("", { status: 404 }) : new Response(new Uint8Array(Buffer.from(body)));
  };
  return { asked, fetchImpl };
}

const unchanged = (dir: string, target: string) => {
  assert.equal(readFileSync(target, "utf8"), "the old binary");
  assert.deepEqual(readdirSync(dir), ["nova-ai"]);
};

test("every release platform has an asset, others have none", () => {
  assert.equal(assetName("darwin", "arm64"), "nova-ai-darwin-arm64.tar.gz");
  assert.equal(assetName("darwin", "x64"), "nova-ai-darwin-x64.tar.gz");
  assert.equal(assetName("linux", "arm64"), "nova-ai-linux-arm64.tar.gz");
  assert.equal(assetName("linux", "x64"), "nova-ai-linux-x64.tar.gz");
  assert.equal(assetName("win32", "arm64"), "nova-ai-windows-arm64.zip");
  assert.equal(assetName("win32", "x64"), "nova-ai-windows-x64.zip");
  assert.equal(assetName("freebsd", "x64"), null);
  assert.equal(assetName("linux", "ia32"), null);
});

test("every target the build script produces is an asset updates look for", () => {
  const script = readFileSync(new URL("../../../../../../scripts/build-binaries.mjs", import.meta.url), "utf8");
  const targets = [...script.matchAll(/^ {2}"(\w+-\w+)": "bun-/gm)].map((match) => match[1]!);
  assert.equal(targets.length, 6);
  for (const target of targets) {
    const [os, arch] = target.split("-") as [string, string];
    assert.match(assetName(os === "windows" ? "win32" : (os as NodeJS.Platform), arch) ?? "", new RegExp(`^nova-ai-${target}\\.`));
  }
});

test("the release tag is encoded, it contains @ and /", () => {
  assert.match(releasePage("1.2.0-alpha.3"), /\/tag\/%40datalabrotterdam%2Fnova-ai-cli%401\.2\.0-alpha\.3$/);
});

test("reads a checksum from sha256sum and shasum output", () => {
  const hash = "a".repeat(64);
  assert.equal(checksumFor(`${"b".repeat(64)}  other.zip\n${hash}  ${ASSET}\n`, ASSET), hash);
  assert.equal(checksumFor(`${hash} *${ASSET}\r\n`, ASSET), hash);
  assert.equal(checksumFor(`${hash}  ${ASSET}.sig\nnot a line\n`, ASSET), null);
});

test("installs a verified release over the binary, keeping its mode", posixOnly, async (t) => {
  const { dir, target } = installed(t);
  const archive = archiveWith(t, `nova-ai ${NEW_VERSION}`);
  const { asked, fetchImpl } = fakeRelease({ [ASSET]: archive, SHA256SUMS: `${sha(archive)}  ${ASSET}\n` });
  await installBinaryUpdate(NEW_VERSION, { target, asset: ASSET, fetchImpl });
  assert.equal(execFileSync(target, ["--version"], { encoding: "utf8" }).trim(), `nova-ai ${NEW_VERSION}`);
  assert.equal(statSync(target).mode & 0o777, 0o751);
  assert.deepEqual(readdirSync(dir), ["nova-ai"]);
  assert.ok(asked.every((url) => url.startsWith("https://github.com/Datalab-Rotterdam/nova-ai-cli/releases/download/%40datalabrotterdam%2Fnova-ai-cli%402.0.0/")));
});

test("a damaged download changes nothing", posixOnly, async (t) => {
  const { dir, target } = installed(t);
  const archive = archiveWith(t, `nova-ai ${NEW_VERSION}`);
  const { fetchImpl } = fakeRelease({ [ASSET]: archive, SHA256SUMS: `${"0".repeat(64)}  ${ASSET}\n` });
  await assert.rejects(installBinaryUpdate(NEW_VERSION, { target, asset: ASSET, fetchImpl }), /does not match its checksum/);
  unchanged(dir, target);
});

test("a binary reporting another version is not installed", posixOnly, async (t) => {
  const { dir, target } = installed(t);
  const archive = archiveWith(t, "nova-ai 1.9.0");
  const { fetchImpl } = fakeRelease({ [ASSET]: archive, SHA256SUMS: `${sha(archive)}  ${ASSET}\n` });
  await assert.rejects(installBinaryUpdate(NEW_VERSION, { target, asset: ASSET, fetchImpl }), /reported "nova-ai 1.9.0"/);
  unchanged(dir, target);
});

test("a binary that does not start is not installed", posixOnly, async (t) => {
  const { dir, target } = installed(t);
  const archive = archiveWith(t, "x\"; exit 1; echo \"");
  const { fetchImpl } = fakeRelease({ [ASSET]: archive, SHA256SUMS: `${sha(archive)}  ${ASSET}\n` });
  await assert.rejects(installBinaryUpdate(NEW_VERSION, { target, asset: ASSET, fetchImpl }));
  unchanged(dir, target);
});

test("an archive without the binary changes nothing", posixOnly, async (t) => {
  const { dir, target } = installed(t);
  const archive = archiveWith(t, "x", "something-else");
  const { fetchImpl } = fakeRelease({ [ASSET]: archive, SHA256SUMS: `${sha(archive)}  ${ASSET}\n` });
  await assert.rejects(installBinaryUpdate(NEW_VERSION, { target, asset: ASSET, fetchImpl }));
  unchanged(dir, target);
});

test("a release still uploading is reported as not ready", async (t) => {
  const { dir, target } = installed(t);
  const sums = `${"0".repeat(64)}  ${ASSET}\n`;
  const releases: Array<Record<string, string>> = [{}, { SHA256SUMS: sums }, { SHA256SUMS: "" }];
  for (const files of releases) {
    await assert.rejects(
      installBinaryUpdate(NEW_VERSION, { target, asset: ASSET, fetchImpl: fakeRelease(files).fetchImpl }),
      UpdateNotReadyError,
    );
  }
  unchanged(dir, target);
});

test("a server error is a failure, not 'not ready'", async (t) => {
  const { dir, target } = installed(t);
  const fetchImpl = async () => new Response("", { status: 503 });
  await assert.rejects(installBinaryUpdate(NEW_VERSION, { target, asset: ASSET, fetchImpl }), (error) => {
    assert.ok(!(error instanceof UpdateNotReadyError));
    return /status 503/.test((error as Error).message);
  });
  unchanged(dir, target);
});

test("a platform without a build stops before downloading", async (t) => {
  const { target } = installed(t);
  const { asked, fetchImpl } = fakeRelease({});
  await assert.rejects(installBinaryUpdate(NEW_VERSION, { target, asset: null, fetchImpl }), /no build/);
  assert.deepEqual(asked, []);
});

test("Windows moves the running binary aside, and cleans it up at the next start", (t) => {
  const { dir, target } = installed(t);
  const fresh = join(dir, "fresh");
  writeFileSync(fresh, "new");
  swapBinary(fresh, target, "win32");
  assert.equal(readFileSync(target, "utf8"), "new");
  assert.equal(readFileSync(`${target}.old`, "utf8"), "the old binary");
  removeReplacedBinary(target);
  assert.deepEqual(readdirSync(dir), ["nova-ai"]);
});

test("Windows puts the old binary back when the new one cannot move in", (t) => {
  const { dir, target } = installed(t);
  const fresh = join(dir, "fresh");
  writeFileSync(fresh, "new");
  let renames = 0;
  const rename = (from: string, to: string) => {
    if (++renames === 2) throw new Error("locked by a virus scanner");
    renameSync(from, to);
  };
  assert.throws(() => swapBinary(fresh, target, "win32", rename), /virus scanner/);
  assert.equal(readFileSync(target, "utf8"), "the old binary");
  assert.equal(existsSync(`${target}.old`), false);
});

test("a read-only folder means a binary only gets the notice", posixOnly, (t) => {
  // Root ignores permissions; containers often run as root.
  if (process.getuid?.() === 0) return t.skip("running as root");
  const { dir, target } = installed(t);
  assert.equal(binaryInstallable(target), true);
  chmodSync(dir, 0o555);
  try {
    assert.equal(binaryInstallable(target), false);
  } finally {
    chmodSync(dir, 0o755); // Before the cleanup, which has to delete from this folder.
  }
});
