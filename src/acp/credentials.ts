import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type StoredCredentials = {
  apiKey: string;
  defaultModel?: string;
};

const CREDENTIALS_PATH = join(homedir(), ".nova-ai", "credentials.json");

/**
 * Single place that owns "how we get the Nova API key", so swapping this for
 * an OAuth-based Agent Auth flow later only touches this file.
 */
export function readCredentials(): StoredCredentials | null {
  const envApiKey = process.env.NOVA_API_KEY;
  if (envApiKey) {
    return { apiKey: envApiKey, defaultModel: process.env.NOVA_MODEL };
  }

  try {
    const raw = readFileSync(CREDENTIALS_PATH, "utf8");
    return JSON.parse(raw) as StoredCredentials;
  } catch {
    return null;
  }
}

export function writeCredentials(credentials: StoredCredentials): void {
  mkdirSync(dirname(CREDENTIALS_PATH), { recursive: true });
  writeFileSync(CREDENTIALS_PATH, JSON.stringify(credentials, null, 2), {
    mode: 0o600,
  });
}

export function credentialsPath(): string {
  return CREDENTIALS_PATH;
}
