import type * as acp from "@agentclientprotocol/sdk";
import type { ChatMessage } from "@datalabrotterdam/nova-sdk";
import type { SessionRunner } from "../../src/tui/session/session-runner.js";

type Entry = {
  id: string;
  version: number;
  text: string;
  prompt: acp.ContentBlock[];
  kind: "steer" | "followup";
  createdAt: string;
  editing: boolean;
};

type QueueAgent = {
  queuePrompt(params: {
    text: string;
    prompt: acp.ContentBlock[];
    kind?: Entry["kind"];
    front?: boolean;
  }): { entry: Entry; entries: Entry[] };
  listPromptQueue(): { entries: Entry[] };
  beginQueuedPromptEdit(params: { id: string }): {
    updated: boolean;
    entries: Entry[];
  };
  updateQueuedPrompt(params: {
    id: string;
    text?: string;
    prompt?: acp.ContentBlock[];
    editing?: boolean;
    expectedVersion?: number;
  }): { updated: boolean; entries: Entry[] };
  removeQueuedPrompt(params: { id: string }): {
    removed: boolean;
    entries: Entry[];
  };
  clearPromptQueue(): { cleared: number; entries: Entry[] };
  takeNextQueuedPrompt(): Entry | null;
  takeSteeringMessages(
    params: { sessionId: string },
    client: acp.AgentContext,
  ): Promise<ChatMessage[]>;
  contextUsage(): {
    categories: Record<string, number>;
    totalTokens: number;
    contextWindow: null;
    remainingTokens: null;
    percentUsed: null;
    estimated: true;
  };
};

export function installFakeAgentQueue(runner: SessionRunner): QueueAgent {
  const entries: Entry[] = [];
  const internals = runner as unknown as {
    agentSessionLoaded: boolean;
    ensureSession(): Promise<void>;
    agent: QueueAgent;
  };
  internals.agentSessionLoaded = true;
  internals.ensureSession = async () => {};

  const snapshot = () => entries.map((entry) => ({ ...entry }));
  const agent = internals.agent;
  agent.queuePrompt = (params) => {
    const entry: Entry = {
      id: `fake-queue-${entries.length + 1}`,
      version: 1,
      text: params.text,
      prompt: params.prompt.map((block) => ({ ...block })),
      kind: params.kind ?? "followup",
      createdAt: new Date(0).toISOString(),
      editing: false,
    };
    if (params.front) entries.unshift(entry);
    else entries.push(entry);
    return { entry: { ...entry }, entries: snapshot() };
  };
  agent.listPromptQueue = () => ({ entries: snapshot() });
  agent.beginQueuedPromptEdit = ({ id }) => {
    const entry = entries.find((candidate) => candidate.id === id);
    if (entry) entry.editing = true;
    return { updated: Boolean(entry), entries: snapshot() };
  };
  agent.updateQueuedPrompt = ({
    id,
    text,
    prompt,
    editing,
    expectedVersion,
  }) => {
    const entry = entries.find((candidate) => candidate.id === id);
    const canUpdate = Boolean(
      entry &&
      (expectedVersion === undefined || entry.version === expectedVersion),
    );
    if (entry && canUpdate) {
      if (text !== undefined) entry.text = text;
      if (prompt !== undefined)
        entry.prompt = prompt.map((block) => ({ ...block }));
      if (editing !== undefined) entry.editing = editing;
      entry.version++;
    }
    return { updated: canUpdate, entries: snapshot() };
  };
  agent.removeQueuedPrompt = ({ id }) => {
    const index = entries.findIndex((candidate) => candidate.id === id);
    if (index >= 0) entries.splice(index, 1);
    return { removed: index >= 0, entries: snapshot() };
  };
  agent.clearPromptQueue = () => {
    const cleared = entries.length;
    entries.length = 0;
    return { cleared, entries: [] };
  };
  agent.takeNextQueuedPrompt = () => {
    if (entries[0]?.editing) return null;
    return entries.shift() ?? null;
  };
  agent.takeSteeringMessages = async ({ sessionId }, client) => {
    let count = 0;
    while (entries[count]?.kind === "steer" && !entries[count]?.editing)
      count++;
    const steering = entries.splice(0, count);
    await client.notify("queue/changed", { sessionId, entries: snapshot() });
    for (const entry of steering) {
      await client.notify("session/update", {
        sessionId,
        update: {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: entry.text },
        },
      });
    }
    return steering.map((entry) => ({
      role: "user" as const,
      content:
        entry.prompt.length === 1 && entry.prompt[0]?.type === "text"
          ? entry.prompt[0].text
          : entry.prompt,
    })) as ChatMessage[];
  };
  agent.contextUsage = () => ({
    categories: {
      system: 0,
      conversation: 0,
      agents: 0,
      tools: 0,
      thinking: 0,
      skills: 0,
      memory: 0,
    },
    totalTokens: 0,
    contextWindow: null,
    remainingTokens: null,
    percentUsed: null,
    estimated: true,
  });
  return agent;
}
