import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { novaHomeRoot } from "../nova-home.js";

/**
 * Whether a model accepts OpenAI-style native tool calls. Learned per model
 * and remembered across runs: unknown models are tried natively first, and a
 * server that rejects `tools` marks the model unsupported so later turns go
 * straight to the text (```tool_call) protocol.
 */
export type ToolSupport = "supported" | "unsupported" | "unknown";

export class ToolSupportStore {
  private cache: Record<string, ToolSupport> | null = null;

  constructor(private readonly path = defaultPath()) {}

  get(model: string): ToolSupport {
    return this.load()[model] ?? "unknown";
  }

  set(model: string, support: Exclude<ToolSupport, "unknown">): void {
    const data = this.load();
    if (data[model] === support) return;
    data[model] = support;
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      const temp = `${this.path}.${process.pid}.tmp`;
      writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
      renameSync(temp, this.path);
      chmodSync(this.path, 0o600);
    } catch {
      // A cache that cannot be written only costs a retry next run.
    }
  }

  private load(): Record<string, ToolSupport> {
    if (this.cache) return this.cache;
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(readFileSync(this.path, "utf8"));
    } catch {
      parsed = null;
    }
    const data: Record<string, ToolSupport> = {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [model, value] of Object.entries(parsed)) {
        if (value === "supported" || value === "unsupported") data[model] = value;
      }
    }
    this.cache = data;
    return data;
  }
}

function defaultPath(): string {
  return join(novaHomeRoot(), "model-capabilities.json");
}

/** Thrown before anything is recorded when the server rejects native tools. */
export class ToolCallingUnsupportedError extends Error {
  constructor(readonly cause: unknown) {
    super("The model rejected native tool calling.");
    this.name = "ToolCallingUnsupportedError";
  }
}

/** A 400 that names tools/functions: the server or model has no tool parser. */
export function isToolCallingRejected(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as Record<string, unknown>;
  if (record.status !== 400) return false;
  const detail = [
    error instanceof Error ? error.message : "",
    typeof record.code === "string" ? record.code : "",
    typeof record.type === "string" ? record.type : "",
    typeof record.body === "string" ? record.body : safeJson(record.body),
  ]
    .join(" ")
    .toLowerCase();
  return /\btools?\b|tool_choice|tool[_ ]call|function/.test(detail);
}

function safeJson(value: unknown): string {
  try {
    return value === undefined ? "" : JSON.stringify(value);
  } catch {
    return "";
  }
}
