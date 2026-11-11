import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { CLI_PACKAGE_NAME } from "./version.js";

/*
 * Updating a standalone binary from its GitHub release, the counterpart of `npm install -g`.
 * Nothing changes until the download matched SHA256SUMS and the new binary reported the
 * expected version. SHA256SUMS comes from the same release: it catches a damaged download,
 * not a compromised release.
 */
const RELEASES_URL = "https://github.com/Datalab-Rotterdam/nova-ai-cli/releases";
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1_000;

const encodedTag = (version: string): string => encodeURIComponent(`${CLI_PACKAGE_NAME}@${version}`);

export function releasePage(version: string): string {
  return `${RELEASES_URL}/tag/${encodedTag(version)}`;
}

/** The release asset for a platform; null when there is none. */
export function assetName(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string | null {
  if (arch !== "x64" && arch !== "arm64") return null;
  if (platform === "win32") return `nova-ai-windows-${arch}.zip`;
  if (platform === "darwin" || platform === "linux") return `nova-ai-${platform}-${arch}.tar.gz`;
  return null;
}

export function binaryPath(): string {
  return realpathSync(process.execPath);
}

/** Whether this binary can replace itself: the swap happens in its own folder. */
export function binaryInstallable(path: string = binaryPath()): boolean {
  if (!assetName()) return false;
  try {
    accessSync(dirname(path), constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** The release has no files (yet): npm publishes first, so this is normal for a few minutes. */
export class UpdateNotReadyError extends Error {}

export function checksumFor(sums: string, asset: string): string | null {
  for (const line of sums.split("\n")) {
    const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(line.trim());
    if (match?.[2] === asset) return match[1]!;
  }
  return null;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

async function download(url: string, fetchImpl: FetchLike): Promise<Buffer> {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (response.status === 404) throw new UpdateNotReadyError(`Nothing at ${url}`);
  if (!response.ok) throw new Error(`Downloading ${url} failed with status ${response.status}.`);
  return Buffer.from(await response.arrayBuffer());
}

function extract(archive: string, into: string): void {
  // Windows' own tar reads zip; one from Git for Windows, first on some PATHs, does not.
  const tar = process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
  mkdirSync(into);
  execFileSync(tar, ["-xf", archive, "-C", into], { stdio: "ignore", timeout: 60_000 });
}

/**
 * Puts `fresh` in place of the running binary, both in one folder. POSIX replaces a running
 * file atomically; Windows only lets it be renamed, so it moves aside until the next start.
 */
export function swapBinary(
  fresh: string,
  target: string,
  platform: NodeJS.Platform = process.platform,
  rename: (from: string, to: string) => void = renameSync,
): void {
  if (platform !== "win32") {
    rename(fresh, target);
    return;
  }
  const old = `${target}.old`;
  rmSync(old, { force: true });
  rename(target, old);
  try {
    rename(fresh, target);
  } catch (error) {
    rename(old, target);
    throw error;
  }
}

/** Removes what a Windows update left beside the binary; only possible once it stopped running. */
export function removeReplacedBinary(path: string = binaryPath()): void {
  try {
    rmSync(`${path}.old`, { force: true });
  } catch {
    // The previous version still runs in another terminal; the next start tries again.
  }
}

export type BinaryUpdateOptions = {
  target?: string;
  asset?: string | null;
  fetchImpl?: FetchLike;
};

/** Downloads, checks and installs a version. Throws, with nothing changed, when it can't. */
export async function installBinaryUpdate(version: string, options: BinaryUpdateOptions = {}): Promise<void> {
  const target = options.target ?? binaryPath();
  const fetchImpl = options.fetchImpl ?? fetch;
  const asset = options.asset === undefined ? assetName() : options.asset;
  if (!asset) throw new Error(`There is no build for ${process.platform} ${process.arch}.`);

  const base = `${RELEASES_URL}/download/${encodedTag(version)}`;
  const sums = (await download(`${base}/SHA256SUMS`, fetchImpl)).toString("utf8");
  const expected = checksumFor(sums, asset);
  if (!expected) throw new UpdateNotReadyError(`${asset} is not in SHA256SUMS.`);
  const archive = await download(`${base}/${asset}`, fetchImpl);
  if (createHash("sha256").update(archive).digest("hex") !== expected) {
    throw new Error(`${asset} does not match its checksum.`);
  }

  // Beside the binary, because a rename only is atomic within one file system.
  const work = mkdtempSync(join(dirname(target), ".nova-ai-update-"));
  try {
    const archivePath = join(work, asset);
    writeFileSync(archivePath, archive);
    const unpacked = join(work, "unpacked");
    extract(archivePath, unpacked);
    const fresh = join(unpacked, basename(target).endsWith(".exe") ? "nova-ai.exe" : "nova-ai");
    if (!lstatSync(fresh).isFile()) throw new Error(`${asset} does not contain the binary.`);
    chmodSync(fresh, statSync(target).mode & 0o777);
    const reported = execFileSync(fresh, ["--version"], {
      encoding: "utf8",
      timeout: 30_000,
      env: { ...process.env, NOVA_NO_UPDATE_CHECK: "1", NOVA_AI_BROWSER_AUTO_SETUP: "0" },
    }).trim();
    if (reported !== `nova-ai ${version}`) throw new Error(`The new binary reported "${reported}".`);
    swapBinary(fresh, target);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
