import type { ChatMessage, NovaAI } from "@datalabrotterdam/nova-sdk";
import { chatContentToText } from "./chat-content.js";
import { resolveModelMetadata } from "./model-capabilities.js";
import { stripReasoningTags } from "./reasoning-tags.js";

const DEFAULT_CONTEXT_WINDOW = 32_768;
const MAX_RECENT_MESSAGES = 8;
const MAX_SOURCE_CHARS = 180_000;
const MIN_SOURCE_CHARS = 8_000;
const MAX_SUMMARY_ATTEMPTS = 2;
const MAX_SUMMARY_TOKENS = 8_192;

export const COMPACTION_SUMMARY_PREFIX = "[Conversation context compacted]";

export type ContextCompactionResult = {
  compacted: boolean;
  history: ChatMessage[];
  removedMessages: number;
  keptMessages: number;
};

export function isContextLimitError(error: unknown): boolean {
  const record =
    error && typeof error === "object"
      ? (error as Record<string, unknown>)
      : null;
  const status = typeof record?.status === "number" ? record.status : null;
  const code = typeof record?.code === "string" ? record.code : "";
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  const body = record?.body;
  const bodyText = typeof body === "string" ? body : safeJson(body);
  const detail = `${code}\n${message}\n${bodyText}`;

  if (/context_length_exceeded|context_window_exceeded/i.test(detail))
    return true;
  if (status !== null && status !== 400 && status !== 413) return false;
  return /maximum context length|input_tokens|prompt (?:is )?too (?:large|long)|reduce the length of the input prompt/i.test(
    detail,
  );
}

export function contextWindowFromError(error: unknown): number | null {
  const record =
    error && typeof error === "object"
      ? (error as Record<string, unknown>)
      : null;
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  const body =
    typeof record?.body === "string" ? record.body : safeJson(record?.body);
  const match = /maximum context length is\s+([\d,]+)\s+tokens/i.exec(
    `${message}\n${body}`,
  );
  if (!match?.[1]) return null;
  const value = Number(match[1].replace(/,/g, ""));
  return Number.isFinite(value) && value > 0 ? value : null;
}

export async function resolveModelContextWindow(
  novaClient: NovaAI,
  model: string,
): Promise<number> {
  try {
    const metadata = await resolveModelMetadata(novaClient, model);
    const value = metadata?.context_window ?? metadata?.max_model_len;
    return typeof value === "number" && value > 0
      ? value
      : DEFAULT_CONTEXT_WINDOW;
  } catch {
    return DEFAULT_CONTEXT_WINDOW;
  }
}

export async function compactConversation(
  history: ChatMessage[],
  novaClient: NovaAI,
  model: string,
  options: { signal?: AbortSignal; contextWindow?: number } = {},
): Promise<ContextCompactionResult> {
  if (history.length < 2) {
    return {
      compacted: false,
      history: [...history],
      removedMessages: 0,
      keptMessages: history.length,
    };
  }

  const contextWindow = options.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  const recentBudget = Math.max(
    MIN_SOURCE_CHARS,
    Math.floor(contextWindow * 0.2),
  );
  const preferredRecentCount = Math.min(
    MAX_RECENT_MESSAGES,
    Math.max(1, Math.floor(history.length / 3)),
  );
  let splitIndex = history.length;
  let recentChars = 0;
  let recentCount = 0;

  while (splitIndex > 0 && recentCount < preferredRecentCount) {
    const candidate = serializeMessage(history[splitIndex - 1]!);
    if (recentCount > 0 && recentChars + candidate.length > recentBudget) break;
    splitIndex--;
    recentCount++;
    recentChars += candidate.length;
  }

  if (splitIndex <= 0) {
    return {
      compacted: false,
      history: [...history],
      removedMessages: 0,
      keptMessages: history.length,
    };
  }

  const older = history.slice(0, splitIndex);
  const recent = history.slice(splitIndex);
  const source = older.map(serializeMessage).join("\n\n");
  const sourceBudget = Math.min(
    MAX_SOURCE_CHARS,
    Math.max(MIN_SOURCE_CHARS, Math.floor(contextWindow * 0.55)),
  );
  const summary = await summarizeSource(
    source,
    novaClient,
    model,
    sourceBudget,
    contextWindow,
    options.signal,
  );
  const summaryMessage: ChatMessage = {
    role: "system",
    content: `${COMPACTION_SUMMARY_PREFIX}\nThis summary replaces ${older.length} earlier conversation messages. Preserve it as authoritative context.\n\n${summary}`,
  };
  const compactedHistory = [summaryMessage, ...recent];

  return {
    compacted: true,
    history: compactedHistory,
    removedMessages: older.length,
    keptMessages: recent.length,
  };
}

async function summarizeSource(
  source: string,
  novaClient: NovaAI,
  model: string,
  sourceBudget: number,
  contextWindow: number,
  signal?: AbortSignal,
): Promise<string> {
  let summaries = await summarizeChunks(
    splitText(source, sourceBudget),
    novaClient,
    model,
    contextWindow,
    signal,
  );
  let pass = 0;

  while (summaries.length > 1 && summaries.join("\n\n").length > sourceBudget) {
    if (++pass > 8)
      throw new Error(
        "Context compaction could not reduce the conversation enough.",
      );
    const combined = summaries
      .map((summary, index) => `Summary part ${index + 1}:\n${summary}`)
      .join("\n\n");
    summaries = await summarizeChunks(
      splitText(combined, sourceBudget),
      novaClient,
      model,
      contextWindow,
      signal,
    );
  }

  return summaries.join("\n\n");
}

async function summarizeChunks(
  chunks: string[],
  novaClient: NovaAI,
  model: string,
  contextWindow: number,
  signal?: AbortSignal,
): Promise<string[]> {
  const summaries: string[] = [];
  for (const chunk of chunks) {
    summaries.push(
      await summarizeChunk(chunk, novaClient, model, contextWindow, signal),
    );
  }
  return summaries;
}

async function summarizeChunk(
  source: string,
  novaClient: NovaAI,
  model: string,
  contextWindow: number,
  signal?: AbortSignal,
): Promise<string> {
  const baseBudget = Math.min(
    MAX_SUMMARY_TOKENS,
    Math.max(512, Math.floor(contextWindow * 0.05)),
  );

  for (let attempt = 1; attempt <= MAX_SUMMARY_ATTEMPTS; attempt++) {
    const response = await novaClient.chat.completions.create(
      {
        model,
        messages: [
          {
            role: "system",
            content:
              "Compact the supplied conversation into durable working context. Preserve user requirements, decisions, file paths, code changes, commands, errors, tool results, unresolved tasks, and current state. Remove repetition and conversational filler. Do not invent facts. Respond with the summary text only.",
          },
          { role: "user", content: source },
        ],
        // A retry bumps temperature and widens the token budget — a reasoning
        // model that burned its whole budget "thinking" (leaving nothing for
        // the actual summary) reproduces the same empty result at identical
        // settings, so a byte-identical retry never helps.
        temperature: attempt === 1 ? 0.1 : 0.4,
        max_tokens: Math.min(MAX_SUMMARY_TOKENS, baseBudget * attempt),
      },
      { signal },
    );
    const content = response.choices[0]?.message.content;
    const visible =
      typeof content === "string" ? stripReasoningTags(content).trim() : "";
    if (visible) return visible;
  }
  throw new Error("Nova AI returned an empty context-compaction summary.");
}

function serializeMessage(message: ChatMessage): string {
  const content = chatContentToText(message.content);
  return `${message.role.toUpperCase()}:\n${content}`;
}

function splitText(value: string, maximum: number): string[] {
  if (!value) return ["(No textual content.)"];
  const chunks: string[] = [];
  for (let offset = 0; offset < value.length; offset += maximum) {
    chunks.push(value.slice(offset, offset + maximum));
  }
  return chunks;
}

function safeJson(value: unknown): string {
  if (value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
