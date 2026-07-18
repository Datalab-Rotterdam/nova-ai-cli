import { createRequire } from "node:module";
import type { UpdateAvailable } from "./state/types.js";

const PACKAGE_NAME = "@datalabrotterdam/nova-ai-cli";
const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME.replace("/", "%2F")}/latest`;
const DEFAULT_TIMEOUT_MS = 3_000;

export const UPDATE_COMMAND =
  "npm install -g @datalabrotterdam/nova-ai-cli@latest";

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

type UpdateCheckOptions = {
  currentVersion?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
};

/** Checks npm without delaying startup; registry and parsing failures are ignored. */
export async function checkForUpdate(
  options: UpdateCheckOptions = {},
): Promise<UpdateAvailable | null> {
  try {
    const currentVersion = options.currentVersion ?? readInstalledVersion();
    if (!currentVersion) return null;
    const response = await (options.fetchImpl ?? fetch)(REGISTRY_URL, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const payload: unknown = await response.json();
    if (!isVersionPayload(payload)) return null;
    if (!isNewerVersion(payload.version, currentVersion)) return null;
    return {
      currentVersion,
      latestVersion: payload.version,
      command: UPDATE_COMMAND,
    };
  } catch {
    return null;
  }
}

/** Reads package metadata at runtime so semantic-release's final version wins. */
export function readInstalledVersion(): string | null {
  const require = createRequire(import.meta.url);
  for (const path of [
    "../package.json",
    "../../package.json",
    "../../../package.json",
  ]) {
    try {
      const metadata: unknown = require(path);
      if (isVersionPayload(metadata)) return metadata.version;
    } catch {
      // Source, compiled tests, and the bundled CLI have different depths.
    }
  }
  return process.env.npm_package_version ?? null;
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

function isVersionPayload(value: unknown): value is { version: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "version" in value &&
    typeof value.version === "string"
  );
}

function parseVersion(
  value: string,
): { core: [number, number, number]; prerelease: string[] } | null {
  const match =
    /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
      value,
    );
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
    if (leftNumber !== null && rightNumber !== null)
      return leftNumber - rightNumber;
    if (leftNumber !== null || rightNumber !== null)
      return leftNumber !== null ? -1 : 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}
