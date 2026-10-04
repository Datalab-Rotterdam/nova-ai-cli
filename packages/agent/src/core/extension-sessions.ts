import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChatMessage } from "@datalabrotterdam/nova-sdk";
import { projectPaths } from "./nova-home.js";
import {
  deriveTitle,
  isValidSessionId,
  sessionsUseProjectLayout,
  writeImportedSession,
} from "./sessions.js";

/**
 * The VS Code extension's chat panel keeps its chats in
 * `projects/<key>/sessions/` (index.json + <id>.json, docs/NOVA_HOME.md).
 * Listing a workspace's sessions (listStoredSessions with a cwd: ACP
 * session/list, the TUI's /resume, --continue) imports those chats into the
 * agent's own format, so one history list shows them all. The import is
 * one-time per chat: imported ids are recorded next to the agent's
 * sessions, and the extension's files are left untouched.
 */
const EXTENSION_SESSIONS_DIR = "sessions";
const IMPORT_RECORD = "extension-import.json";
const UNANSWERED_CALL = "Tool error: Cancelled before this call completed.";

/** The extension's names for tools the agent calls differently. */
const TOOL_NAMES: Record<string, string> = {
  list_dir: "list_directory",
  create_file: "write_file",
  todo_write: "update_plan",
};

export type ExtensionStoredPart =
  | { type: "text"; value: string }
  | { type: "toolCall"; callId: string; name: string; input: object }
  | { type: "toolResult"; callId: string; text: string };

export type ExtensionStoredSession = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: Array<{ role: "user" | "assistant"; parts: ExtensionStoredPart[] }>;
};

type NativeToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

/**
 * Imports the chats of the workspace at `cwd` that were not imported before.
 * Never throws; returns how many sessions were written.
 */
export function importExtensionSessions(cwd: string): number {
  if (!sessionsUseProjectLayout()) return 0;
  try {
    const paths = projectPaths(cwd);
    const sourceDir = join(paths.dir, EXTENSION_SESSIONS_DIR);
    const ids = readIndexIds(join(sourceDir, "index.json"));
    if (!ids.length) return 0;

    const recordPath = join(paths.cliSessions, IMPORT_RECORD);
    const done = new Set(readImportRecord(recordPath));
    const pending = ids.filter((id) => !done.has(id));
    if (!pending.length) return 0;

    let imported = 0;
    for (const id of pending) {
      done.add(id);
      if (!isValidSessionId(id)) continue;
      let stored: ExtensionStoredSession;
      try {
        stored = JSON.parse(readFileSync(join(sourceDir, `${id}.json`), "utf8")) as ExtensionStoredSession;
      } catch {
        continue; // missing or unreadable: nothing to import
      }
      const turns = extensionSessionToTurns(stored);
      if (!turns.length) continue;
      const messages = turns.flatMap((turn) => turn.messages);
      const title =
        typeof stored.title === "string" && stored.title.trim() && stored.title !== "New chat"
          ? stored.title
          : deriveTitle(messages);
      if (writeImportedSession(id, { cwd, title }, turns)) imported++;
    }
    mkdirSync(paths.cliSessions, { recursive: true, mode: 0o700 });
    writeFileSync(recordPath, `${JSON.stringify({ imported: [...done] }, null, 2)}\n`, { mode: 0o600 });
    return imported;
  } catch {
    return 0;
  }
}

/**
 * The chat as the agent's turns. A turn starts with the user's text after a
 * final answer (or at the start); user text during tool work is steering
 * and stays in the running turn. Tool results become `tool`
 * messages right after the call, and every call gets an answer, as the
 * model API requires.
 */
export function extensionSessionToTurns(
  stored: ExtensionStoredSession,
): Array<{ updatedAt: string; messages: ChatMessage[] }> {
  if (!stored || !Array.isArray(stored.messages)) return [];
  const updatedAt = toIso(stored.updatedAt);
  const turns: ChatMessage[][] = [];
  let current: ChatMessage[] | null = null;
  // The last message was a final answer (assistant text without calls).
  let afterAnswer = false;
  let pendingCalls: string[] = [];

  const push = (message: ChatMessage) => {
    if (!current) {
      current = [];
      turns.push(current);
    }
    current.push(message);
  };
  const answer = (callId: string, content: string) => {
    pendingCalls = pendingCalls.filter((id) => id !== callId);
    push({ role: "tool", tool_call_id: callId, content } as ChatMessage);
  };
  const answerRest = () => {
    for (const callId of [...pendingCalls]) answer(callId, UNANSWERED_CALL);
  };

  for (const message of stored.messages) {
    const parts = Array.isArray(message?.parts) ? message.parts : [];
    if (message.role === "assistant") {
      answerRest();
      const text = parts
        .filter((part) => part.type === "text")
        .map((part) => (part as { value: string }).value)
        .join("");
      const calls: NativeToolCall[] = parts
        .filter((part): part is Extract<ExtensionStoredPart, { type: "toolCall" }> => part.type === "toolCall")
        .map((part) => ({
          id: part.callId,
          type: "function",
          function: { name: TOOL_NAMES[part.name] ?? part.name, arguments: JSON.stringify(part.input ?? {}) },
        }));
      if (!text && !calls.length) continue;
      push({ role: "assistant", content: text, ...(calls.length ? { tool_calls: calls } : {}) } as ChatMessage);
      pendingCalls = calls.map((call) => call.id);
      afterAnswer = calls.length === 0;
      continue;
    }

    for (const part of parts) {
      // A result without its call (cut by compaction) would be rejected.
      if (part.type === "toolResult" && pendingCalls.includes(part.callId)) answer(part.callId, part.text);
    }
    answerRest();
    const text = parts
      .filter((part) => part.type === "text")
      .map((part) => (part as { value: string }).value)
      .join("\n\n");
    if (text) {
      if (afterAnswer) current = null; // the user's next prompt: a new turn
      push({ role: "user", content: text });
    }
    afterAnswer = false;
  }
  answerRest();
  return turns.map((messages) => ({ updatedAt, messages }));
}

function readIndexIds(path: string): string[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry) => (entry && typeof entry === "object" ? (entry as { id?: unknown }).id : undefined))
      .filter((id): id is string => typeof id === "string");
  } catch {
    return [];
  }
}

function readImportRecord(path: string): string[] {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { imported?: unknown };
    return Array.isArray(parsed.imported) ? parsed.imported.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function toIso(value: unknown): string {
  const time = typeof value === "number" && Number.isFinite(value) ? value : Date.now();
  return new Date(time).toISOString();
}
