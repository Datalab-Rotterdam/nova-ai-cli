import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { novaHomeRoot } from "@datalabrotterdam/nova-ai-agent/core/nova-home.js";
import type { UpdateAvailable } from "./tui/state/types.js";
import { CLI_PACKAGE_NAME, cliVersion } from "./version.js";

/** All of the package's dist-tags (latest, alpha, …) in one small request. */
const DIST_TAGS_URL = `https://registry.npmjs.org/-/package/${CLI_PACKAGE_NAME.replace("/", "%2F")}/dist-tags`;
const DEFAULT_TIMEOUT_MS = 3_000;
/** npm is asked at most once a day; the answer is shared by every run. */
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type UpdateCheckOptions = {
  currentVersion?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  /** Where the last answer is kept; null disables the cache (tests). */
  cachePath?: string | null;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  /** Cancels the request (the caller stopped waiting). */
  signal?: AbortSignal;
};

type DistTags = Record<string, string>;
type CacheFile = {
  checkedAt: number;
  distTags: DistTags;
  /** "Skip this version" at the start-up prompt: not asked again for it. */
  skippedVersion?: string;
  /** "Not today" at the start-up prompt: not asked again before this time. */
  snoozedUntil?: number;
};

export function updateCachePath(): string {
  return join(novaHomeRoot(), "update-check.json");
}

/** Off in CI and when NOVA_NO_UPDATE_CHECK or NO_UPDATE_NOTIFIER is set. */
export function updateChecksDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.NOVA_NO_UPDATE_CHECK || env.NO_UPDATE_NOTIFIER || env.CI);
}

/**
 * Whether a newer nova-ai-cli is on npm. A pre-release install (e.g.
 * 1.2.0-alpha.2) is compared with its own channel (the `alpha` tag) and with
 * `latest`; a stable install only with `latest`. The suggestion uses the tag
 * of the newer version. Never throws; offline, slow or odd answers are null.
 */
export async function checkForUpdate(options: UpdateCheckOptions = {}): Promise<UpdateAvailable | null> {
  try {
    if (updateChecksDisabled(options.env)) return null;
    const currentVersion = options.currentVersion ?? cliVersion();
    if (!currentVersion) return null;
    const distTags = await readDistTags(options);
    if (!distTags) return null;
    return chooseUpdate(currentVersion, distTags);
  } catch {
    return null;
  }
}

export function chooseUpdate(currentVersion: string, distTags: DistTags): UpdateAvailable | null {
  const channel = prereleaseChannel(currentVersion);
  const tags = channel && distTags[channel] ? [channel, "latest"] : ["latest"];
  let best: { tag: string; version: string } | null = null;
  for (const tag of tags) {
    const version = distTags[tag];
    if (!version || !isNewerVersion(version, currentVersion)) continue;
    if (!best || isNewerVersion(version, best.version)) best = { tag, version };
  }
  if (!best) return null;
  return {
    currentVersion,
    latestVersion: best.version,
    tag: best.tag,
    command: `npm install -g ${CLI_PACKAGE_NAME}@${best.tag}`,
  };
}

async function readDistTags(options: UpdateCheckOptions): Promise<DistTags | null> {
  const now = (options.now ?? Date.now)();
  const cachePath = options.cachePath === undefined ? updateCachePath() : options.cachePath;
  const cached = cachePath ? readCache(cachePath) : null;
  if (cached && now - cached.checkedAt >= 0 && now - cached.checkedAt < CACHE_MAX_AGE_MS) {
    return cached.distTags;
  }
  const response = await (options.fetchImpl ?? fetch)(DIST_TAGS_URL, {
    headers: { accept: "application/json" },
    signal: AbortSignal.any([
      AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      ...(options.signal ? [options.signal] : []),
    ]),
  });
  if (!response.ok) return null;
  const payload: unknown = await response.json();
  if (!isDistTags(payload)) return null;
  if (cachePath) writeCache(cachePath, { ...cached, checkedAt: now, distTags: payload });
  return payload;
}

function readCache(path: string): CacheFile | null {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (
      value &&
      typeof value === "object" &&
      typeof (value as CacheFile).checkedAt === "number" &&
      isDistTags((value as CacheFile).distTags)
    ) {
      return value as CacheFile;
    }
  } catch {
    // missing or unreadable: ask npm
  }
  return null;
}

const SNOOZE_MS = 24 * 60 * 60 * 1_000;

export type UpdatePromptOptions = {
  cachePath?: string | null;
  now?: () => number;
};

/** Whether the start-up prompt may ask about this update (not skipped, not snoozed). */
export function shouldAskAboutUpdate(update: UpdateAvailable, options: UpdatePromptOptions = {}): boolean {
  const cachePath = options.cachePath === undefined ? updateCachePath() : options.cachePath;
  const cached = cachePath ? readCache(cachePath) : null;
  if (!cached) return true;
  if (cached.skippedVersion === update.latestVersion) return false;
  const now = (options.now ?? Date.now)();
  return !(typeof cached.snoozedUntil === "number" && now < cached.snoozedUntil);
}

/** Remembers "not today" (asked again after a day) or "skip this version". */
export function rememberUpdateAnswer(
  answer: "later" | "skip",
  update: UpdateAvailable,
  options: UpdatePromptOptions = {},
): void {
  const cachePath = options.cachePath === undefined ? updateCachePath() : options.cachePath;
  if (!cachePath) return;
  const cached = readCache(cachePath);
  // Without dist-tags the cache is stale, so the next start asks npm again.
  const base: CacheFile = cached ?? { checkedAt: 0, distTags: {} };
  const now = (options.now ?? Date.now)();
  writeCache(
    cachePath,
    answer === "skip"
      ? { ...base, skippedVersion: update.latestVersion, snoozedUntil: undefined }
      : { ...base, snoozedUntil: now + SNOOZE_MS },
  );
}

function writeCache(path: string, value: CacheFile): void {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  } catch {
    // the cache is an optimisation only
  }
}

function isDistTags(value: unknown): value is DistTags {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((version) => typeof version === "string")
  );
}

/** "alpha" for 1.2.0-alpha.2, null for a stable version. */
function prereleaseChannel(version: string): string | null {
  const parsed = parseVersion(version);
  const first = parsed?.prerelease[0];
  return first && !/^\d+$/.test(first) ? first : null;
}

/** Reads package metadata at runtime so semantic-release's final version wins. */
export function readInstalledVersion(): string | null {
  return cliVersion();
}

export function isNewerVersion(candidate: string, current: string): boolean {
  const next = parseVersion(candidate);
  const installed = parseVersion(current);
  if (!next || !installed) return false;

  for (let index = 0; index < 3; index++) {
    const difference = next.core[index]! - installed.core[index]!;
    if (difference !== 0) return difference > 0;
  }
  return comparePrerelease(next.prerelease, installed.prerelease) > 0;
}

function parseVersion(value: string): { core: [number, number, number]; prerelease: string[] } | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value);
  if (!match) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4]?.split(".") ?? [],
  };
}

function comparePrerelease(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) {
    if (left.length === right.length) return 0;
    return left.length === 0 ? 1 : -1;
  }

  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index++) {
    const leftPart = left[index];
    const rightPart = right[index];
    if (leftPart === undefined || rightPart === undefined) {
      return leftPart === rightPart ? 0 : leftPart === undefined ? -1 : 1;
    }
    if (leftPart === rightPart) continue;
    const leftNumber = /^\d+$/.test(leftPart) ? Number(leftPart) : null;
    const rightNumber = /^\d+$/.test(rightPart) ? Number(rightPart) : null;
    if (leftNumber !== null && rightNumber !== null) return leftNumber - rightNumber;
    if (leftNumber !== null || rightNumber !== null) return leftNumber !== null ? -1 : 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

/** The one line printed to stderr after `-p` or `--version`. */
export function formatUpdateNotice(update: UpdateAvailable): string {
  return `Update available: nova-ai ${update.currentVersion} → ${update.latestVersion}. Run: ${update.command}`;
}
