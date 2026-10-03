import type * as acp from "@agentclientprotocol/sdk";

export type PromptQueueKind = "steer" | "followup";

export type PromptQueueEntry = {
  id: string;
  version: number;
  text: string;
  prompt: acp.ContentBlock[];
  kind: PromptQueueKind;
  createdAt: string;
  editing: boolean;
};

export type PromptQueueEntryView = Omit<PromptQueueEntry, "prompt">;

export type EnqueuePromptParams = {
  sessionId: string;
  text: string;
  prompt: acp.ContentBlock[];
  kind?: PromptQueueKind;
  front?: boolean;
};

export type QueueSessionParams = { sessionId: string };
export type QueueEntryParams = QueueSessionParams & { id: string };
export type UpdateQueuedPromptParams = QueueEntryParams & {
  text?: string;
  prompt?: acp.ContentBlock[];
  editing?: boolean;
  expectedVersion?: number;
};

/**
 * Ordered, session-scoped prompt queue. The queue lives beside model history,
 * not in a particular UI, so every ACP client observes the same work order.
 */
export class PromptQueue {
  private readonly entries: PromptQueueEntry[] = [];

  list(): PromptQueueEntryView[] {
    return this.entries.map(toView);
  }

  enqueue(input: Omit<EnqueuePromptParams, "sessionId">): PromptQueueEntryView {
    const now = new Date().toISOString();
    const entry: PromptQueueEntry = {
      id: `queue-${crypto.randomUUID()}`,
      version: 1,
      text: input.text,
      prompt: clonePrompt(input.prompt),
      kind: input.kind ?? "followup",
      createdAt: now,
      editing: false,
    };
    if (input.front) this.entries.unshift(entry);
    else this.entries.push(entry);
    return toView(entry);
  }

  beginEdit(id: string): boolean {
    const entry = this.entries.find((candidate) => candidate.id === id);
    if (!entry) return false;
    entry.editing = true;
    entry.version++;
    return true;
  }

  update(
    id: string,
    patch: Omit<UpdateQueuedPromptParams, "sessionId" | "id">,
  ): boolean {
    const entry = this.entries.find((candidate) => candidate.id === id);
    if (!entry) return false;
    if (
      patch.expectedVersion !== undefined &&
      entry.version !== patch.expectedVersion
    ) {
      return false;
    }
    if (patch.text !== undefined) entry.text = patch.text;
    if (patch.prompt !== undefined) entry.prompt = clonePrompt(patch.prompt);
    if (patch.editing !== undefined) entry.editing = patch.editing;
    entry.version++;
    return true;
  }

  remove(id: string): boolean {
    const index = this.entries.findIndex((candidate) => candidate.id === id);
    if (index < 0) return false;
    this.entries.splice(index, 1);
    return true;
  }

  clear(): number {
    const count = this.entries.length;
    this.entries.length = 0;
    return count;
  }

  /** Steering is consumed only from the contiguous, unlocked queue prefix. */
  takeSteering(): PromptQueueEntry[] {
    let count = 0;
    for (const entry of this.entries) {
      if (entry.kind !== "steer" || entry.editing) break;
      count++;
    }
    return this.entries.splice(0, count);
  }

  /** Promote the next unlocked item after the active turn has settled. */
  takeNext(): PromptQueueEntry | null {
    const entry = this.entries[0];
    if (!entry || entry.editing) return null;
    return this.entries.shift() ?? null;
  }
}

export function parseEnqueuePromptParams(params: unknown): EnqueuePromptParams {
  const value = requireRecord(params);
  const prompt = value.prompt;
  if (!Array.isArray(prompt)) {
    throw new Error("prompt must be an array of ACP content blocks");
  }
  const kind = value.kind;
  if (kind !== undefined && kind !== "steer" && kind !== "followup") {
    throw new Error('kind must be either "steer" or "followup"');
  }
  return {
    sessionId: requireString(value.sessionId, "sessionId"),
    text: requireString(value.text, "text"),
    prompt: prompt as acp.ContentBlock[],
    kind,
    front: optionalBoolean(value.front, "front"),
  };
}

export function parseQueueSessionParams(params: unknown): QueueSessionParams {
  const value = requireRecord(params);
  return { sessionId: requireString(value.sessionId, "sessionId") };
}

export function parseQueueEntryParams(params: unknown): QueueEntryParams {
  const value = requireRecord(params);
  return {
    sessionId: requireString(value.sessionId, "sessionId"),
    id: requireString(value.id, "id"),
  };
}

export function parseUpdateQueuedPromptParams(
  params: unknown,
): UpdateQueuedPromptParams {
  const value = requireRecord(params);
  const prompt = value.prompt;
  if (prompt !== undefined && !Array.isArray(prompt)) {
    throw new Error("prompt must be an array of ACP content blocks");
  }
  return {
    sessionId: requireString(value.sessionId, "sessionId"),
    id: requireString(value.id, "id"),
    text: optionalString(value.text, "text"),
    prompt: prompt as acp.ContentBlock[] | undefined,
    editing: optionalBoolean(value.editing, "editing"),
    expectedVersion: optionalNumber(value.expectedVersion, "expectedVersion"),
  };
}

function clonePrompt(prompt: acp.ContentBlock[]): acp.ContentBlock[] {
  return prompt.map((block) => ({ ...block }));
}

function toView(entry: PromptQueueEntry): PromptQueueEntryView {
  const { prompt: _prompt, ...view } = entry;
  return { ...view };
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("params must be an object");
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return value;
}

function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`);
  return value;
}

function optionalNumber(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return Number(value);
}
