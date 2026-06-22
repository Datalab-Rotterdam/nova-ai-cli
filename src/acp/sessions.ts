import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ChatMessage } from "@datalabrotterdam/nova-sdk";

export type StoredSession = {
  sessionId: string;
  cwd: string;
  title: string | null;
  updatedAt: string;
  messages: ChatMessage[];
};

type HeaderLine = { kind: "header"; cwd: string; title: string | null };
type MessageLine = { kind: "message"; updatedAt: string; message: ChatMessage };
type SessionLine = HeaderLine | MessageLine;

const SESSIONS_DIR = join(homedir(), ".nova-ai", "sessions");

function sessionFilePath(sessionId: string): string {
  return join(SESSIONS_DIR, `${sessionId}.jsonl`);
}

function parseSessionFile(raw: string): StoredSession | null {
  let header: HeaderLine | null = null;
  const messages: ChatMessage[] = [];
  let updatedAt = "";

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const parsed = JSON.parse(line) as SessionLine;
    if (parsed.kind === "header") {
      header = parsed;
    } else {
      messages.push(parsed.message);
      updatedAt = parsed.updatedAt;
    }
  }

  if (!header) return null;
  return { sessionId: "", cwd: header.cwd, title: header.title, updatedAt, messages };
}

export function loadStoredSession(sessionId: string): StoredSession | null {
  try {
    const raw = readFileSync(sessionFilePath(sessionId), "utf8");
    const session = parseSessionFile(raw);
    return session ? { ...session, sessionId } : null;
  } catch {
    return null;
  }
}

/**
 * Each turn is appended as its own line rather than rewriting the whole
 * session file, so persisting after every prompt stays O(1) instead of
 * O(history length).
 */
export function appendSessionTurn(
  sessionId: string,
  header: { cwd: string; title: string | null },
  newMessages: ChatMessage[],
): void {
  mkdirSync(SESSIONS_DIR, { recursive: true });
  const path = sessionFilePath(sessionId);
  const updatedAt = new Date().toISOString();

  const lines: string[] = [];
  // Re-stating the header is cheap and keeps title updates (set once the
  // first user message arrives) visible without rewriting prior lines.
  lines.push(JSON.stringify({ kind: "header", cwd: header.cwd, title: header.title } satisfies HeaderLine));
  for (const message of newMessages) {
    lines.push(JSON.stringify({ kind: "message", updatedAt, message } satisfies MessageLine));
  }

  appendFileSync(path, `${lines.join("\n")}\n`);
}

export function listStoredSessions(cwd?: string): StoredSession[] {
  let files: string[];
  try {
    files = readdirSync(SESSIONS_DIR);
  } catch {
    return [];
  }

  const sessions: StoredSession[] = [];
  for (const file of files) {
    if (!file.endsWith(".jsonl")) continue;
    const sessionId = file.slice(0, -".jsonl".length);
    try {
      const raw = readFileSync(join(SESSIONS_DIR, file), "utf8");
      const session = parseSessionFile(raw);
      if (!session) continue;
      if (!cwd || session.cwd === cwd) sessions.push({ ...session, sessionId });
    } catch {
      // Skip corrupt/partial session files rather than failing the whole listing.
    }
  }

  return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function deriveTitle(messages: ChatMessage[]): string | null {
  const firstUser = messages.find((m) => m.role === "user");
  if (!firstUser || typeof firstUser.content !== "string") return null;
  const text = firstUser.content.trim();
  if (!text) return null;
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}
