import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ChatMessage } from "@datalabrotterdam/nova-sdk";
import { chatContentToText } from "../core/chat-content.js";

export type StoredSession = {
  sessionId: string;
  cwd: string;
  title: string | null;
  updatedAt: string;
  messages: ChatMessage[];
};

type HeaderLine = { kind: "header"; cwd: string; title: string | null };
type MessageLine = { kind: "message"; updatedAt: string; message: ChatMessage };
type CompactionLine = {
  kind: "compaction";
  updatedAt: string;
  messages: ChatMessage[];
};
type SessionLine = HeaderLine | MessageLine | CompactionLine;

const SESSIONS_DIR = join(homedir(), ".nova-ai", "sessions");

function sessionFilePath(sessionId: string): string {
  return join(SESSIONS_DIR, `${sessionId}.jsonl`);
}

export function parseSessionFile(raw: string): StoredSession | null {
  let header: HeaderLine | null = null;
  const messages: ChatMessage[] = [];
  let updatedAt = "";

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const parsed = JSON.parse(line) as SessionLine;
    if (parsed.kind === "header") {
      header = parsed;
    } else if (parsed.kind === "message") {
      messages.push(parsed.message);
      updatedAt = parsed.updatedAt;
    } else if (parsed.kind === "compaction" && Array.isArray(parsed.messages)) {
      messages.splice(0, messages.length, ...parsed.messages);
      updatedAt = parsed.updatedAt;
    }
  }

  if (!header) return null;
  return {
    sessionId: "",
    cwd: header.cwd,
    title: header.title,
    updatedAt,
    messages,
  };
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
  lines.push(
    JSON.stringify({
      kind: "header",
      cwd: header.cwd,
      title: header.title,
    } satisfies HeaderLine),
  );
  for (const message of newMessages) {
    lines.push(
      JSON.stringify({
        kind: "message",
        updatedAt,
        message,
      } satisfies MessageLine),
    );
  }

  appendFileSync(path, `${lines.join("\n")}\n`);
}

/**
 * Appends a reset marker containing the reduced history. Readers discard all
 * earlier message lines when they encounter this marker, so compaction remains
 * crash-safe without rewriting or truncating the active session file.
 */
export function appendSessionCompaction(
  sessionId: string,
  header: { cwd: string; title: string | null },
  messages: ChatMessage[],
): void {
  mkdirSync(SESSIONS_DIR, { recursive: true });
  const path = sessionFilePath(sessionId);
  const updatedAt = new Date().toISOString();
  const lines = [
    JSON.stringify({
      kind: "header",
      cwd: header.cwd,
      title: header.title,
    } satisfies HeaderLine),
    JSON.stringify({
      kind: "compaction",
      updatedAt,
      messages,
    } satisfies CompactionLine),
  ];
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

export function deleteStoredSession(sessionId: string): void {
  try {
    unlinkSync(sessionFilePath(sessionId));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/**
 * Copies a session's current (already-compacted) history under a new id as a
 * single turn. Only point-in-time content is needed for a fork, not the
 * source's turn-by-turn audit history.
 */
export function forkStoredSession(
  sourceSessionId: string,
  newSessionId: string,
  overrides: { cwd: string },
): StoredSession | null {
  const source = loadStoredSession(sourceSessionId);
  if (!source) return null;
  appendSessionTurn(
    newSessionId,
    { cwd: overrides.cwd, title: source.title },
    source.messages,
  );
  return { ...source, sessionId: newSessionId, cwd: overrides.cwd };
}

export function deriveTitle(messages: ChatMessage[]): string | null {
  const firstUser = messages.find((m) => m.role === "user");
  if (!firstUser) return null;
  const text = chatContentToText(firstUser.content).replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}
