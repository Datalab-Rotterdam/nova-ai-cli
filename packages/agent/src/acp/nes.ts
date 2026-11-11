import { fileURLToPath } from "node:url";
import { isAbsolute } from "node:path";
import type * as acp from "@agentclientprotocol/sdk";

export type NesDocument = {
  uri: string;
  languageId: string | null;
  version: number;
  text: string;
};

export type NesSession = {
  workspaceUri: string | null;
  workspaceFolders: acp.WorkspaceFolder[];
  repository: acp.NesRepository | null;
  createdAt: string;
  documents: Map<string, NesDocument>;
  pendingByUri: Map<string, AbortController>;
  suggestionIds: Set<string>;
};

type SuggestPositionJson = {
  line: number;
  character: number;
};

type SuggestEditJson = {
  range?: {
    start: SuggestPositionJson;
    end: SuggestPositionJson;
  };
  startLine?: number;
  startChar?: number;
  endLine?: number;
  endChar?: number;
  newText: string;
};

const CONTEXT_LINES = 60;
const MAX_LINE_CHARS = 600;
const MAX_CONTEXT_ITEM_CHARS = 2_000;
const MAX_EDITS = 4;
const MAX_EDIT_TEXT_CHARS = 20_000;
const MAX_REPLACED_CHARS = 20_000;

export function createNesSession(params: acp.StartNesRequest): NesSession {
  return {
    workspaceUri: params.workspaceUri ?? null,
    workspaceFolders: [...(params.workspaceFolders ?? [])],
    repository: params.repository ?? null,
    createdAt: new Date().toISOString(),
    documents: new Map(),
    pendingByUri: new Map(),
    suggestionIds: new Set(),
  };
}

export function openNesDocument(
  session: NesSession,
  params: acp.DidOpenDocumentNotification,
): void {
  cancelNesRequest(session, params.uri);
  session.documents.set(params.uri, {
    uri: params.uri,
    languageId: params.languageId,
    version: params.version,
    text: params.text,
  });
}

export function changeNesDocument(
  session: NesSession,
  params: acp.DidChangeDocumentNotification,
  encoding: acp.PositionEncodingKind,
): void {
  const document = session.documents.get(params.uri);
  if (!document || params.version <= document.version) return;
  const text = applyContentChanges(document.text, params.contentChanges, encoding);
  if (text === null) return;
  cancelNesRequest(session, params.uri);
  session.documents.set(params.uri, {
    ...document,
    version: params.version,
    text,
  });
}

export function closeNesDocument(session: NesSession, uri: string): void {
  cancelNesRequest(session, uri);
  session.documents.delete(uri);
}

export function beginNesRequest(
  session: NesSession,
  uri: string,
): AbortController {
  cancelNesRequest(session, uri);
  const controller = new AbortController();
  session.pendingByUri.set(uri, controller);
  return controller;
}

export function finishNesRequest(
  session: NesSession,
  uri: string,
  controller: AbortController,
): void {
  if (session.pendingByUri.get(uri) === controller) {
    session.pendingByUri.delete(uri);
  }
}

export function closeNesSession(session: NesSession): void {
  for (const controller of session.pendingByUri.values()) controller.abort();
  session.pendingByUri.clear();
  session.documents.clear();
  session.suggestionIds.clear();
}

export function rememberNesSuggestions(
  session: NesSession,
  suggestions: acp.NesSuggestion[],
): void {
  for (const suggestion of suggestions) session.suggestionIds.add(suggestion.id);
  while (session.suggestionIds.size > 100) {
    const oldest = session.suggestionIds.values().next().value as
      | string
      | undefined;
    if (!oldest) break;
    session.suggestionIds.delete(oldest);
  }
}

export function forgetNesSuggestion(session: NesSession, id: string): void {
  session.suggestionIds.delete(id);
}

export function buildSuggestPrompt(params: {
  document: NesDocument;
  position: acp.Position;
  selection?: acp.Range | null;
  triggerKind: acp.NesTriggerKind;
  context?: acp.NesSuggestContext | null;
  positionEncoding: acp.PositionEncodingKind;
  workspaceUri?: string | null;
  workspaceFolders?: acp.WorkspaceFolder[] | null;
  repository?: acp.NesRepository | null;
}): string {
  const lines = params.document.text.split(/\r?\n/);
  const start = Math.max(0, params.position.line - CONTEXT_LINES);
  const end = Math.min(lines.length, params.position.line + CONTEXT_LINES + 1);
  const windowed = lines
    .slice(start, end)
    .map((line, index) => {
      const lineNumber = start + index;
      const cursor = lineNumber === params.position.line ? "  < cursor" : "";
      return `${lineNumber}: ${truncate(line, MAX_LINE_CHARS)}${cursor}`;
    })
    .join("\n");

  const recentFiles = params.context?.recentFiles
    ?.filter((file) => file.uri !== params.document.uri)
    .slice(0, 5)
    .map(
      (file) =>
        `${file.uri} (${file.languageId}):\n${truncate(file.text, MAX_CONTEXT_ITEM_CHARS)}`,
    )
    .join("\n\n");
  const relatedSnippets = params.context?.relatedSnippets
    ?.slice(0, 5)
    .flatMap((snippet) =>
      snippet.excerpts.slice(0, 3).map(
        (excerpt) =>
          `${snippet.uri}:${excerpt.startLine}-${excerpt.endLine}\n${truncate(excerpt.text, MAX_CONTEXT_ITEM_CHARS)}`,
      ),
    )
    .join("\n\n");
  const editHistory = params.context?.editHistory
    ?.slice(0, 8)
    .map(
      (entry) =>
        `${entry.uri}:\n${truncate(entry.diff, MAX_CONTEXT_ITEM_CHARS)}`,
    )
    .join("\n\n");
  const openFiles = params.context?.openFiles
    ?.slice(0, 20)
    .map((file) => `${file.uri} (${file.languageId})`)
    .join(", ");
  const diagnostics = params.context?.diagnostics
    ?.slice(0, 20)
    .map(
      (diagnostic) =>
        `${diagnostic.severity} ${diagnostic.uri}:${formatRange(diagnostic.range)} ${truncate(diagnostic.message, 400)}`,
    )
    .join("\n");
  const repository = params.repository
    ? `${params.repository.owner}/${params.repository.name}`
    : null;

  return [
    `Suggest the single most useful next inline code edit for ${params.document.uri}.`,
    `Document version: ${params.document.version}. Language: ${params.document.languageId ?? "unknown"}. Trigger: ${params.triggerKind}.`,
    `Cursor: line ${params.position.line}, character ${params.position.character}. Character offsets use ${params.positionEncoding}.`,
    params.selection ? `Selection: ${formatRange(params.selection)}.` : null,
    params.workspaceUri ? `Workspace: ${params.workspaceUri}.` : null,
    params.workspaceFolders?.length
      ? `Workspace folders: ${params.workspaceFolders
          .slice(0, 10)
          .map((folder) => `${folder.name} (${folder.uri})`)
          .join(", ")}.`
      : null,
    repository ? `Repository: ${repository}.` : null,
    `Current document around the cursor (0-based line numbers):\n${windowed}`,
    recentFiles ? `Recent files:\n${recentFiles}` : null,
    relatedSnippets ? `Related snippets:\n${relatedSnippets}` : null,
    editHistory ? `Recent edits:\n${editHistory}` : null,
    openFiles ? `Open files: ${openFiles}` : null,
    diagnostics ? `Diagnostics:\n${diagnostics}` : null,
    [
      "Return JSON only, with no prose or Markdown fences:",
      '{"edits":[{"range":{"start":{"line":0,"character":0},"end":{"line":0,"character":0}},"newText":"..."}],"cursorPosition":{"line":0,"character":0}}',
      'Use {"edits":[]} when no confident, local, immediately useful edit is warranted.',
      "Keep edits minimal, non-overlapping, and valid for the exact document version above.",
    ].join("\n"),
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function parseSuggestResponse(
  raw: string,
  document: NesDocument,
  encoding: acp.PositionEncodingKind = "utf-16",
): acp.NesSuggestion[] {
  try {
    const match = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const jsonText = (match ? match[1] : raw).trim();
    const parsed = JSON.parse(jsonText) as {
      edits?: SuggestEditJson[];
      cursorPosition?: SuggestPositionJson | null;
    };
    if (
      !Array.isArray(parsed.edits) ||
      parsed.edits.length === 0 ||
      parsed.edits.length > MAX_EDITS
    ) {
      return [];
    }

    const edits: acp.NesTextEdit[] = [];
    for (const candidate of parsed.edits) {
      const edit = normalizeEdit(candidate);
      if (!edit || !validRange(document.text, edit.range, encoding)) return [];
      if (edit.newText.length > MAX_EDIT_TEXT_CHARS) return [];
      const startOffset = positionToOffset(
        document.text,
        edit.range.start,
        encoding,
      );
      const endOffset = positionToOffset(
        document.text,
        edit.range.end,
        encoding,
      );
      if (startOffset === null || endOffset === null) return [];
      if (endOffset - startOffset > MAX_REPLACED_CHARS) return [];
      if (document.text.slice(startOffset, endOffset) === edit.newText) continue;
      edits.push(edit);
    }
    if (edits.length === 0 || hasOverlappingEdits(edits)) return [];

    const cursorPosition = parsed.cursorPosition;
    const editedDocument = applyTextEdits(document.text, edits, encoding);
    if (editedDocument === null) return [];
    if (
      cursorPosition !== undefined &&
      cursorPosition !== null &&
      positionToOffset(editedDocument, cursorPosition, encoding) === null
    ) {
      return [];
    }

    return [
      {
        kind: "edit",
        id: crypto.randomUUID(),
        uri: document.uri,
        edits,
        ...(cursorPosition ? { cursorPosition } : {}),
      },
    ];
  } catch {
    return [];
  }
}

export function applyContentChanges(
  initial: string,
  changes: acp.TextDocumentContentChangeEvent[],
  encoding: acp.PositionEncodingKind = "utf-16",
): string | null {
  let text = initial;
  for (const change of changes) {
    if (!change.range) {
      text = change.text;
      continue;
    }
    const start = positionToOffset(text, change.range.start, encoding);
    const end = positionToOffset(text, change.range.end, encoding);
    if (start === null || end === null || start > end) return null;
    text = `${text.slice(0, start)}${change.text}${text.slice(end)}`;
  }
  return text;
}

export function uriToAbsolutePath(uri: string): string | null {
  if (isAbsolute(uri)) return uri;
  try {
    const url = new URL(uri);
    return url.protocol === "file:" ? fileURLToPath(url) : null;
  } catch {
    return null;
  }
}

export function selectPositionEncoding(
  supported: acp.PositionEncodingKind[] | null | undefined,
): acp.PositionEncodingKind {
  if (!supported?.length || supported.includes("utf-16")) return "utf-16";
  if (supported.includes("utf-8")) return "utf-8";
  return "utf-32";
}

function cancelNesRequest(session: NesSession, uri: string): void {
  session.pendingByUri.get(uri)?.abort();
  session.pendingByUri.delete(uri);
}

function normalizeEdit(candidate: SuggestEditJson): acp.NesTextEdit | null {
  if (!candidate || typeof candidate.newText !== "string") return null;
  const range = candidate.range ?? {
    start: {
      line: candidate.startLine as number,
      character: candidate.startChar as number,
    },
    end: {
      line: candidate.endLine as number,
      character: candidate.endChar as number,
    },
  };
  if (!validPositionShape(range.start) || !validPositionShape(range.end)) {
    return null;
  }
  return { range, newText: candidate.newText };
}

function validPositionShape(value: SuggestPositionJson): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    Number.isInteger(value.line) &&
    value.line >= 0 &&
    Number.isInteger(value.character) &&
    value.character >= 0
  );
}

function validRange(
  text: string,
  range: acp.Range,
  encoding: acp.PositionEncodingKind,
): boolean {
  const start = positionToOffset(text, range.start, encoding);
  const end = positionToOffset(text, range.end, encoding);
  return start !== null && end !== null && start <= end;
}

function positionToOffset(
  text: string,
  position: acp.Position,
  encoding: acp.PositionEncodingKind,
): number | null {
  if (!validPositionShape(position)) return null;
  const lines = lineBounds(text);
  const bounds = lines[position.line];
  if (!bounds) return null;
  const line = text.slice(bounds.start, bounds.end);
  const index = encodedCharacterToJsIndex(line, position.character, encoding);
  return index === null ? null : bounds.start + index;
}

function lineBounds(text: string): Array<{ start: number; end: number }> {
  const result: Array<{ start: number; end: number }> = [];
  let start = 0;
  while (start <= text.length) {
    const newline = text.indexOf("\n", start);
    const rawEnd = newline === -1 ? text.length : newline;
    const end = rawEnd > start && text[rawEnd - 1] === "\r" ? rawEnd - 1 : rawEnd;
    result.push({ start, end });
    if (newline === -1) break;
    start = newline + 1;
  }
  return result;
}

function encodedCharacterToJsIndex(
  line: string,
  character: number,
  encoding: acp.PositionEncodingKind,
): number | null {
  if (encoding === "utf-16") return character <= line.length ? character : null;
  let encodedOffset = 0;
  let jsOffset = 0;
  for (const codePoint of line) {
    if (encodedOffset === character) return jsOffset;
    encodedOffset +=
      encoding === "utf-8" ? Buffer.byteLength(codePoint, "utf8") : 1;
    jsOffset += codePoint.length;
    if (encodedOffset > character) return null;
  }
  return encodedOffset === character ? jsOffset : null;
}

function hasOverlappingEdits(edits: acp.NesTextEdit[]): boolean {
  const ordered = [...edits].sort((left, right) =>
    comparePosition(left.range.start, right.range.start),
  );
  for (let index = 1; index < ordered.length; index++) {
    const previous = ordered[index - 1]!;
    const current = ordered[index]!;
    if (
      comparePosition(previous.range.start, current.range.start) === 0 ||
      comparePosition(previous.range.end, current.range.start) > 0
    ) {
      return true;
    }
  }
  return false;
}

function applyTextEdits(
  text: string,
  edits: acp.NesTextEdit[],
  encoding: acp.PositionEncodingKind,
): string | null {
  const replacements = edits.map((edit) => ({
    start: positionToOffset(text, edit.range.start, encoding),
    end: positionToOffset(text, edit.range.end, encoding),
    newText: edit.newText,
  }));
  if (replacements.some((edit) => edit.start === null || edit.end === null)) {
    return null;
  }
  replacements.sort(
    (left, right) => (right.start as number) - (left.start as number),
  );
  let result = text;
  for (const replacement of replacements) {
    const start = replacement.start as number;
    const end = replacement.end as number;
    result = `${result.slice(0, start)}${replacement.newText}${result.slice(end)}`;
  }
  return result;
}

function comparePosition(left: acp.Position, right: acp.Position): number {
  return left.line - right.line || left.character - right.character;
}

function formatRange(range: acp.Range): string {
  return `${range.start.line}:${range.start.character}-${range.end.line}:${range.end.character}`;
}

function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}
