import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ChatMessage } from "@datalabrotterdam/nova-sdk";
import { chatContentToText } from "./chat-content.js";
import { ensureProject, novaHomeRoot, projectsDir } from "./nova-home.js";
import { truncateStoredToolMessage } from "./tool-output.js";

export type StoredSession = {
  sessionId: string;
  cwd: string;
  title: string | null;
  updatedAt: string;
  messages: ChatMessage[];
};

/**
 * Stamped on every header line. Readers ignore unknown keys, so older CLI
 * versions keep reading newer files; bump only for incompatible changes.
 */
const SESSION_FORMAT_VERSION = 1;

type HeaderLine = {
  kind: "header";
  version?: number;
  cwd: string;
  title: string | null;
};
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

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

/** Flat directory override (tests, custom setups); disables the project layout. */
function overrideDir(): string | null {
  return process.env.NOVA_AI_CLI_SESSIONS_DIR?.trim() || null;
}

/** Where sessions lived before the per-project layout; still read and appended to. */
function legacyDir(): string {
  return join(novaHomeRoot(), "sessions");
}

/** Every directory that may hold session files, existing or not. */
function sessionDirs(): string[] {
  const override = overrideDir();
  if (override) return [override];
  let projectKeys: string[] = [];
  try {
    projectKeys = readdirSync(projectsDir());
  } catch {
    projectKeys = [];
  }
  return [
    legacyDir(),
    ...projectKeys.map((key) => join(projectsDir(), key, "cli-sessions")),
  ];
}

/**
 * Session ids arrive from ACP clients (session/load, resume, fork, rewind,
 * delete) and become file names, so only a plain token is accepted: no path
 * separators, dots, or Windows device names that could escape or alias the
 * sessions directory.
 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com\d|lpt\d)$/i;

export class InvalidSessionIdError extends Error {
  constructor() {
    super("Invalid session id.");
    this.name = "InvalidSessionIdError";
  }
}

export function isValidSessionId(sessionId: unknown): sessionId is string {
  return (
    typeof sessionId === "string" &&
    SESSION_ID_PATTERN.test(sessionId) &&
    !WINDOWS_RESERVED_NAME.test(sessionId)
  );
}

function sessionFileIn(directory: string, sessionId: string): string {
  if (!isValidSessionId(sessionId)) throw new InvalidSessionIdError();
  const dir = resolve(directory);
  const path = resolve(dir, `${sessionId}.jsonl`);
  if (dirname(path) !== dir) throw new InvalidSessionIdError();
  return path;
}

/** The existing file of a session, wherever it lives; null when there is none. */
function findSessionFile(sessionId: string): string | null {
  for (const dir of sessionDirs()) {
    const path = sessionFileIn(dir, sessionId);
    if (existsSync(path)) return path;
  }
  if (!isValidSessionId(sessionId)) throw new InvalidSessionIdError();
  return null;
}

/**
 * The file to append to: the session's existing file (a session never moves
 * between files), else a new one in the project folder of its cwd.
 */
function sessionFileForWrite(sessionId: string, cwd: string): string {
  const existing = findSessionFile(sessionId);
  if (existing) return existing;
  const dir = overrideDir() ?? ensureProject(cwd).cliSessions;
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  return sessionFileIn(dir, sessionId);
}

function readSessionFile(sessionId: string): string | null {
  const path = findSessionFile(sessionId);
  return path ? readFileSync(path, "utf8") : null;
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
  if (
    (message.role !== "user" && message.role !== "tool") ||
    typeof message.content !== "string"
  ) {
    return message;
  }
  const content = truncateStoredToolMessage(message.content);
  return content === message.content ? message : { ...message, content };
}

export function loadStoredSession(sessionId: string): StoredSession | null {
  try {
    const raw = readSessionFile(sessionId);
    if (raw === null) return null;
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
  const path = sessionFileForWrite(sessionId, header.cwd);
  const updatedAt = new Date().toISOString();

  const lines: string[] = [];
  // Re-stating the header is cheap and keeps title updates (set once the
  // first user message arrives) visible without rewriting prior lines.
  lines.push(
    JSON.stringify({
      kind: "header",
      version: SESSION_FORMAT_VERSION,
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

  appendFileSync(path, `${lines.join("\n")}\n`, { mode: FILE_MODE });
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
  const path = sessionFileForWrite(sessionId, header.cwd);
  const updatedAt = new Date().toISOString();
  const lines = [
    JSON.stringify({
      kind: "header",
      version: SESSION_FORMAT_VERSION,
      cwd: header.cwd,
      title: header.title,
    } satisfies HeaderLine),
    JSON.stringify({
      kind: "compaction",
      updatedAt,
      messages,
    } satisfies CompactionLine),
  ];
  appendFileSync(path, `${lines.join("\n")}\n`, { mode: FILE_MODE });
}

export type SessionSummary = {
  sessionId: string;
  cwd: string;
  title: string | null;
  updatedAt: string;
};

/** All stored sessions, newest first, without loading their messages. */
export function listStoredSessions(cwd?: string): SessionSummary[] {
  const sessions = new Map<string, SessionSummary>();
  for (const dir of sessionDirs()) {
    let files: string[];
    try {
      files = readdirSync(dir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const sessionId = file.slice(0, -".jsonl".length);
      if (!isValidSessionId(sessionId) || sessions.has(sessionId)) continue;
      try {
        const summary = readSessionSummary(readFileSync(join(dir, file), "utf8"));
        if (!summary) continue;
        if (!cwd || summary.cwd === cwd) {
          sessions.set(sessionId, { ...summary, sessionId });
        }
      } catch {
        // Skip unreadable session files rather than failing the whole listing.
      }
    }
  }

  return [...sessions.values()].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt),
  );
}

/**
 * Title, cwd and last activity of a session file, scanning from the end:
 * only the last header line is parsed, and the timestamp is read from the
 * start of the last record line (records can hold a whole turn of messages).
 */
export function readSessionSummary(
  raw: string,
): Omit<SessionSummary, "sessionId"> | null {
  const lines = raw.split("\n");
  let updatedAt: string | null = null;
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]!;
    if (!line.trim()) continue;
    if (line.startsWith('{"kind":"header"')) {
      try {
        const header = JSON.parse(line) as HeaderLine;
        return { cwd: header.cwd, title: header.title, updatedAt: updatedAt ?? "" };
      } catch {
        continue; // a torn last line; an earlier header still describes the session
      }
    }
    if (updatedAt === null) {
      const match = /"updatedAt":"([^"]+)"/.exec(line.slice(0, 300));
      if (match) updatedAt = match[1]!;
    }
  }
  return null;
}

export function listSessionCheckpoints(sessionId: string): SessionCheckpoint[] {
  try {
    const raw = readSessionFile(sessionId);
    if (raw === null) return [];
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
  let path: string | null;
  try {
    path = findSessionFile(sessionId);
    timeline = path ? parseSessionTimeline(readFileSync(path, "utf8")) : null;
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
    path!,
    `${[
      JSON.stringify({
        kind: "header",
        version: SESSION_FORMAT_VERSION,
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
  const path = findSessionFile(sessionId);
  if (!path) return;
  try {
    unlinkSync(path);
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
  return { sessionId: requireSessionId(value.sessionId) };
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
    sessionId: requireSessionId(value.sessionId),
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

function requireSessionId(value: unknown): string {
  if (!isValidSessionId(value)) throw new InvalidSessionIdError();
  return value;
}

