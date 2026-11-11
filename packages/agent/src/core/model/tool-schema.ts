import type { ToolDefinition } from "../tools/types.js";

/** OpenAI-compatible servers reject more tools than this. */
export const MAX_TOOLS = 128;

const VALID_TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Bidirectional mapping between our tool names and the names sent to Nova.
 * Most names pass through unchanged; names servers reject (too long, odd
 * characters, e.g. from MCP servers) are sanitized and mapped back on the
 * way out. Ported from nova-ai-vscode src/model/toolSchema.ts.
 */
export class ToolNameMap {
  private readonly toNovaNames = new Map<string, string>();
  private readonly fromNovaNames = new Map<string, string>();

  constructor(names: readonly string[] = []) {
    for (const name of names) this.register(name);
  }

  toNova(name: string): string {
    return this.toNovaNames.get(name) ?? this.register(name);
  }

  /** Our tool name for a name the model produced, or undefined when unknown. */
  fromNova(name: string): string | undefined {
    return this.fromNovaNames.get(name);
  }

  get size(): number {
    return this.toNovaNames.size;
  }

  private register(name: string): string {
    const existing = this.toNovaNames.get(name);
    if (existing) return existing;

    let candidate = VALID_TOOL_NAME.test(name) ? name : sanitizeToolName(name);
    for (let suffix = 2; this.fromNovaNames.has(candidate); suffix++) {
      candidate = `${sanitizeToolName(name).slice(0, 60)}_${suffix}`;
    }

    this.toNovaNames.set(name, candidate);
    this.fromNovaNames.set(candidate, name);
    return candidate;
  }
}

function sanitizeToolName(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  return sanitized || "tool";
}

export type ToolPayload = {
  /** `tools` for the chat request; empty when no tools are offered. */
  tools: Array<{
    type: "function";
    function: {
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    };
  }>;
  names: ToolNameMap;
  /** Tools beyond MAX_TOOLS that could not be offered. */
  dropped: string[];
};

export function buildToolPayload(tools: readonly ToolDefinition[]): ToolPayload {
  const kept = tools.slice(0, MAX_TOOLS);
  const names = new ToolNameMap(kept.map((tool) => tool.name));
  return {
    tools: kept.map((tool) => ({
      type: "function",
      function: {
        name: names.toNova(tool.name),
        description: tool.description || tool.name,
        parameters: normalizeSchema(tool.parameters),
      },
    })),
    names,
    dropped: tools.slice(MAX_TOOLS).map((tool) => tool.name),
  };
}

/**
 * Normalizes a tool input schema so strict servers accept it: the root must
 * be an object schema with `properties`, and `$schema` keys are removed.
 */
export function normalizeSchema(schema: unknown): Record<string, unknown> {
  const normalized = isRecord(schema)
    ? (stripSchemaKeys(schema) as Record<string, unknown>)
    : {};
  if (normalized.type === undefined) normalized.type = "object";
  if (normalized.type === "object" && !isRecord(normalized.properties)) {
    normalized.properties = {};
  }
  return normalized;
}

function stripSchemaKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSchemaKeys);
  if (!isRecord(value)) return value;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key !== "$schema") result[key] = stripSchemaKeys(child);
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
