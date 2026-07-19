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
import { truncateStoredToolMessage } from "../core/tool-output.js";

export type StoredSession = {
  sessionId: string;
  cwd: string;
  title: string | null;
  updatedAt: string;
  messages: ChatMessage[];
};

type HeaderLine = { kind: "header"; cwd: string; title: string | null };
type MessageLine = { kind: "message"; updatedAt: string; message: ChatMessage };
type TurnLine = {
  kind: "turn";
  checkpointId: string;
  updatedAt: string;
  messages: ChatMessage[];
};
type CompactionLine = {
  kind: "compaction";
  updatedAt: string;
  messages: ChatMessage[];
};
type PersistedCheckpoint = SessionCheckpoint & {
  messageCountBefore: number;
  messageCountAfter: number;
};
type RewindLine = {
  kind: "rewind";
  updatedAt: string;
  messages: ChatMessage[];
  checkpoints: PersistedCheckpoint[];
};
type SessionLine =
  HeaderLine | MessageLine | TurnLine | CompactionLine | RewindLine;

export type SessionCheckpoint = {
  checkpointId: string;
  createdAt: string;
  userText: string;
  messageCount: number;
};

export type RewindSessionResult = {
  session: StoredSession;
  removedCheckpoints: SessionCheckpoint[];
  remainingCheckpoints: SessionCheckpoint[];
};

export type SessionIdParams = { sessionId: string };
export type RewindSessionParams = SessionIdParams & { turns?: number };

function sessionsDir(): string {
  return (
    process.env.NOVA_AI_CLI_SESSIONS_DIR ??
    join(homedir(), ".nova-ai", "sessions")
  );
}

function sessionFilePath(sessionId: string): string {
  return join(sessionsDir(), `${sessionId}.jsonl`);
}

export function parseSessionFile(raw: string): StoredSession | null {
  return parseSessionTimeline(raw)?.session ?? null;
}

function parseSessionTimeline(raw: string): {
  session: StoredSession;
  checkpoints: PersistedCheckpoint[];
} | null {
  let header: HeaderLine | null = null;
  const messages: ChatMessage[] = [];
  let checkpoints: PersistedCheckpoint[] = [];
  let updatedAt = "";
  let legacyMessages: ChatMessage[] = [];
  let legacyUpdatedAt = "";
  let legacyIndex = 0;

  const flushLegacyTurn = () => {
    if (!legacyMessages.length) return;
    const normalized = legacyMessages.map(normalizeStoredMessage);
    const messageCountBefore = messages.length;
    messages.push(...normalized);
    checkpoints.push(
      checkpointForTurn(
        `legacy-${legacyUpdatedAt || "unknown"}-${++legacyIndex}`,
        legacyUpdatedAt,
        normalized,
        messageCountBefore,
        messages.length,
      ),
    );
    updatedAt = legacyUpdatedAt || updatedAt;
    legacyMessages = [];
    legacyUpdatedAt = "";
  };

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const parsed = JSON.parse(line) as SessionLine;
    if (parsed.kind === "header") {
      flushLegacyTurn();
      header = parsed;
    } else if (parsed.kind === "message") {
      legacyMessages.push(parsed.message);
      legacyUpdatedAt = parsed.updatedAt;
    } else if (parsed.kind === "turn" && Array.isArray(parsed.messages)) {
      flushLegacyTurn();
      const normalized = parsed.messages.map(normalizeStoredMessage);
      const messageCountBefore = messages.length;
      messages.push(...normalized);
      checkpoints.push(
        checkpointForTurn(
          parsed.checkpointId,
          parsed.updatedAt,
          normalized,
          messageCountBefore,
          messages.length,
        ),
      );
      updatedAt = parsed.updatedAt;
    } else if (parsed.kind === "compaction" && Array.isArray(parsed.messages)) {
      flushLegacyTurn();
      messages.splice(
        0,
        messages.length,
        ...parsed.messages.map(normalizeStoredMessage),
      );
      checkpoints = [];
      updatedAt = parsed.updatedAt;
    } else if (parsed.kind === "rewind" && Array.isArray(parsed.messages)) {
      flushLegacyTurn();
      messages.splice(
        0,
        messages.length,
        ...parsed.messages.map(normalizeStoredMessage),
      );
      checkpoints = Array.isArray(parsed.checkpoints)
        ? parsed.checkpoints.map((checkpoint) => ({ ...checkpoint }))
        : [];
      updatedAt = parsed.updatedAt;
    }
  }
  flushLegacyTurn();

  if (!header) return null;
  return {
    session: {
      sessionId: "",
      cwd: header.cwd,
      title: header.title,
      updatedAt,
      messages,
    },
    checkpoints,
  };
}

function normalizeStoredMessage(message: ChatMessage): ChatMessage {
  if (message.role !== "user" || typeof message.content !== "string") {
    return message;
  }
  const content = truncateStoredToolMessage(message.content);
  return content === message.content ? message : { ...message, content };
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
): SessionCheckpoint {
  mkdirSync(sessionsDir(), { recursive: true });
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
  const checkpointId = crypto.randomUUID();
  lines.push(
    JSON.stringify({
      kind: "turn",
      checkpointId,
      updatedAt,
      messages: newMessages,
    } satisfies TurnLine),
  );

  appendFileSync(path, `${lines.join("\n")}\n`);
  return checkpointForTurn(
    checkpointId,
    updatedAt,
    newMessages,
    0,
    newMessages.length,
  );
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
  mkdirSync(sessionsDir(), { recursive: true });
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
    files = readdirSync(sessionsDir());
  } catch {
    return [];
  }

  const sessions: StoredSession[] = [];
  for (const file of files) {
    if (!file.endsWith(".jsonl")) continue;
    const sessionId = file.slice(0, -".jsonl".length);
    try {
      const raw = readFileSync(join(sessionsDir(), file), "utf8");
      const session = parseSessionFile(raw);
      if (!session) continue;
      if (!cwd || session.cwd === cwd) sessions.push({ ...session, sessionId });
    } catch {
      // Skip corrupt/partial session files rather than failing the whole listing.
    }
  }

  return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function listSessionCheckpoints(sessionId: string): SessionCheckpoint[] {
  try {
    const raw = readFileSync(sessionFilePath(sessionId), "utf8");
    return parseSessionTimeline(raw)?.checkpoints.map(toPublicCheckpoint) ?? [];
  } catch {
    return [];
  }
}

/**
 * Appends a point-in-time reset marker. The original log remains intact for
 * audit/recovery while normal readers see only the rewound conversation.
 */
export function rewindStoredSession(
  sessionId: string,
  turns = 1,
): RewindSessionResult | null {
  if (!Number.isSafeInteger(turns) || turns < 1) {
    throw new Error("turns must be a positive integer");
  }
  let timeline: ReturnType<typeof parseSessionTimeline>;
  try {
    timeline = parseSessionTimeline(
      readFileSync(sessionFilePath(sessionId), "utf8"),
    );
  } catch {
    return null;
  }
  if (!timeline) return null;
  if (turns > timeline.checkpoints.length) {
    throw new Error(
      `Cannot rewind ${turns} turn${turns === 1 ? "" : "s"}; only ${timeline.checkpoints.length} checkpoint${timeline.checkpoints.length === 1 ? " is" : "s are"} available.`,
    );
  }

  const keepCount = timeline.checkpoints.length - turns;
  const removed = timeline.checkpoints.slice(keepCount);
  const remaining = timeline.checkpoints.slice(0, keepCount);
  const targetMessageCount =
    remaining.at(-1)?.messageCountAfter ??
    timeline.checkpoints[0]?.messageCountBefore ??
    0;
  const messages = timeline.session.messages.slice(0, targetMessageCount);
  const updatedAt = new Date().toISOString();
  appendFileSync(
    sessionFilePath(sessionId),
    `${[
      JSON.stringify({
        kind: "header",
        cwd: timeline.session.cwd,
        title: deriveTitle(messages),
      } satisfies HeaderLine),
      JSON.stringify({
        kind: "rewind",
        updatedAt,
        messages,
        checkpoints: remaining,
      } satisfies RewindLine),
    ].join("\n")}\n`,
  );

  return {
    session: {
      ...timeline.session,
      sessionId,
      title: deriveTitle(messages),
      updatedAt,
      messages,
    },
    removedCheckpoints: removed.map(toPublicCheckpoint),
    remainingCheckpoints: remaining.map(toPublicCheckpoint),
  };
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

export function parseSessionIdParams(params: unknown): SessionIdParams {
  const value = requireRecord(params);
  return { sessionId: requireNonEmptyString(value.sessionId, "sessionId") };
}

export function parseRewindSessionParams(params: unknown): RewindSessionParams {
  const value = requireRecord(params);
  const turns = value.turns;
  if (
    turns !== undefined &&
    (!Number.isSafeInteger(turns) || Number(turns) < 1)
  ) {
    throw new Error("turns must be a positive integer");
  }
  return {
    sessionId: requireNonEmptyString(value.sessionId, "sessionId"),
    turns: turns === undefined ? undefined : Number(turns),
  };
}

function checkpointForTurn(
  checkpointId: string,
  createdAt: string,
  messages: ChatMessage[],
  messageCountBefore: number,
  messageCountAfter: number,
): PersistedCheckpoint {
  const userText = messages
    .filter((message) => message.role === "user")
    .map((message) => chatContentToText(message.content))
    .find((text) => text.trim() && !isToolExchangeMessage(text));
  return {
    checkpointId,
    createdAt,
    userText: userText?.replace(/\s+/g, " ").trim() ?? "(continued turn)",
    messageCount: messageCountAfter - messageCountBefore,
    messageCountBefore,
    messageCountAfter,
  };
}

function toPublicCheckpoint(
  checkpoint: PersistedCheckpoint,
): SessionCheckpoint {
  const {
    messageCountBefore: _before,
    messageCountAfter: _after,
    ...view
  } = checkpoint;
  return { ...view };
}

function isToolExchangeMessage(text: string): boolean {
  return (
    /^(?:Tool result:|Tool error:|Tool results \(|Tool call rejected by user\.)/.test(
      text,
    ) ||
    /^Tool "[^"]+" is not available\.$/.test(text) ||
    /^Tool call "[^"]+" has invalid arguments:/.test(text)
  );
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("params must be an object");
  }
  return value as Record<string, unknown>;
}

function requireNonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}
