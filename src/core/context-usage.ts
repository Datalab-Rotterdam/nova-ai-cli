import type { ChatMessage } from "@datalabrotterdam/nova-sdk";
import { extractToolCall } from "../acp/tools/marker.js";
import { chatContentToText } from "./chat-content.js";

export type ContextUsageCategory =
  | "system"
  | "conversation"
  | "agents"
  | "tools"
  | "thinking"
  | "skills"
  | "memory";

export type ContextUsage = {
  categories: Record<ContextUsageCategory, number>;
  totalTokens: number;
  contextWindow: number | null;
  remainingTokens: number | null;
  percentUsed: number | null;
  estimated: true;
};

export type ContextUsageInput = {
  history: ChatMessage[];
  systemPrompt?: string | null;
  toolsPrompt?: string | null;
  skillsPrompt?: string | null;
  memoryPrompt?: string | null;
  contextWindow?: number | null;
};

const TOOL_RESULT_PATTERN =
  /^(?:Tool result:|Tool error:|Tool call rejected by user\.)/;

/**
 * Produces a model-independent context estimate. Nova can serve models with
 * different tokenizers, so the client deliberately reports this as an
 * estimate instead of pretending a local tokenizer is exact for every model.
 */
export function calculateContextUsage(input: ContextUsageInput): ContextUsage {
  const categories: ContextUsage["categories"] = {
    system: 0,
    conversation: 0,
    agents: 0,
    tools: 0,
    thinking: 0,
    skills: 0,
    memory: 0,
  };
  const add = (category: ContextUsageCategory, value: string) => {
    if (value) categories[category] += estimateTokens(value);
  };

  add("system", input.systemPrompt ?? "");
  add("skills", input.skillsPrompt ?? "");
  add("memory", input.memoryPrompt ?? "");
  add("tools", input.toolsPrompt ?? "");

  let pendingToolCategory: ContextUsageCategory | null = null;
  for (const message of input.history) {
    const content = messageText(message);
    if (!content) continue;

    if (message.role === "assistant") {
      const call = extractToolCall(content);
      if (!call) {
        add("agents", content);
        pendingToolCategory = null;
        continue;
      }

      add("thinking", content.slice(0, call.matchStart));
      const category = toolCategory(call.name);
      add(category, content.slice(call.matchStart, call.matchEnd));
      // A well-formed tool turn ends at the marker. Keep any unexpected tail
      // visible in the accounting rather than silently losing it.
      add("agents", content.slice(call.matchEnd));
      pendingToolCategory = category;
      continue;
    }

    if (message.role === "user") {
      if (pendingToolCategory && TOOL_RESULT_PATTERN.test(content)) {
        add(pendingToolCategory, content);
      } else {
        add("conversation", content);
      }
      pendingToolCategory = null;
      continue;
    }

    add("system", content);
    pendingToolCategory = null;
  }

  const totalTokens = Object.values(categories).reduce(
    (total, value) => total + value,
    0,
  );
  const contextWindow =
    typeof input.contextWindow === "number" && input.contextWindow > 0
      ? input.contextWindow
      : null;
  return {
    categories,
    totalTokens,
    contextWindow,
    remainingTokens:
      contextWindow === null ? null : Math.max(0, contextWindow - totalTokens),
    percentUsed:
      contextWindow === null
        ? null
        : Math.min(100, (totalTokens / contextWindow) * 100),
    estimated: true,
  };
}

/** Approximate common LLM tokenization using UTF-8 bytes per token. */
export function estimateTokens(value: string): number {
  if (!value) return 0;
  return Math.max(1, Math.ceil(Buffer.byteLength(value, "utf8") / 4));
}

function toolCategory(name: string): ContextUsageCategory {
  if (name === "load_skill") return "skills";
  if (name === "load_memory" || name === "save_memory") return "memory";
  if (name === "start_background_agent") return "agents";
  return "tools";
}

function messageText(message: ChatMessage): string {
  return chatContentToText(message.content);
}
