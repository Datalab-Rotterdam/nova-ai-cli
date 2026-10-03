import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { novaHomeRoot } from "./nova-home.js";

export type StoredCredentials = {
  apiKey: string;
  defaultModel?: string;
};

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export function credentialsPath(): string {
  return join(novaHomeRoot(), "credentials.json");
}

/**
 * Single place that owns "how we get the Nova API key", so swapping this for
 * an OAuth-based Agent Auth flow later only touches this file.
 *
 * TODO(oidc): today the credential is an API key the user pastes in. It will
 * move to an OIDC binding with the Nova platform (device-code flow for
 * headless/SSH, auth code + PKCE via auth-server.ts for desktop) with
 * short-lived, refreshed tokens. The stored shape then becomes
 * `{ type: "api_key" | "oidc", ... }`; existing API-key files must keep working.
 */
export function readCredentials(): StoredCredentials | null {
  const envApiKey = process.env.NOVA_API_KEY;
  if (envApiKey) {
    return { apiKey: envApiKey, defaultModel: process.env.NOVA_MODEL };
  }
  return readStoredCredentials();
}

/** Credentials from the file only, ignoring NOVA_API_KEY; null when absent or malformed. */
export function readStoredCredentials(): StoredCredentials | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(credentialsPath(), "utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const { apiKey, defaultModel } = parsed as Record<string, unknown>;
  if (typeof apiKey !== "string" || !apiKey.trim()) return null;
  return {
    apiKey,
    defaultModel:
      typeof defaultModel === "string" && defaultModel
        ? defaultModel
        : undefined,
  };
}

/**
 * Writes atomically (temp file + rename) and forces owner-only permissions:
 * `writeFileSync`'s `mode` only applies when it creates the file, so an
 * existing, looser file would otherwise keep its permissions.
 */
export function writeCredentials(credentials: StoredCredentials): void {
  const path = credentialsPath();
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  chmodSync(dir, DIR_MODE);

  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(credentials, null, 2)}\n`, {
      mode: FILE_MODE,
    });
    chmodSync(temp, FILE_MODE);
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  chmodSync(path, FILE_MODE);
}

/**
 * Remembers the chosen model next to the stored key. A key that only comes
 * from NOVA_API_KEY is never copied to disk; returns false when there is no
 * stored key to attach the model to.
 */
export function saveDefaultModel(model: string): boolean {
  const stored = readStoredCredentials();
  if (!stored) return false;
  writeCredentials({ ...stored, defaultModel: model });
  return true;
}
