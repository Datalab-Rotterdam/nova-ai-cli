import * as acp from "@agentclientprotocol/sdk";
import { NOVA_NOTIFICATIONS } from "./extensions.js";
import { type ChatMessage } from "@datalabrotterdam/nova-sdk";
import type { AgentRuntime } from "./agent-runtime.js";
import {
  contentBlocksToNovaContent,
  frameSteeringPrompt,
} from "./prompt-content.js";
import type {
  EnqueuePromptParams,
  PromptQueueEntry,
  PromptQueueEntryView,
  QueueEntryParams,
  QueueSessionParams,
  UpdateQueuedPromptParams,
} from "../core/prompt-queue.js";

/** Prompts queued or used for steering while a turn is running. */
export class QueueService {
  constructor(private readonly runtime: AgentRuntime) {}

  queuePrompt(
    params: EnqueuePromptParams,
    client?: acp.AgentContext,
  ): { entry: PromptQueueEntryView; entries: PromptQueueEntryView[] } {
    const session = this.runtime.requireSession(params.sessionId);
    const entry = session.promptQueue.enqueue({
      text: params.text,
      prompt: params.prompt,
      kind: params.kind,
      front: params.front,
    });
    const entries = session.promptQueue.list();
    this.notifyPromptQueue(params.sessionId, entries, client);
    return { entry, entries };
  }

  listPromptQueue(params: QueueSessionParams): {
    entries: PromptQueueEntryView[];
  } {
    return {
      entries: this.runtime.requireSession(params.sessionId).promptQueue.list(),
    };
  }

  beginQueuedPromptEdit(
    params: QueueEntryParams,
    client?: acp.AgentContext,
  ): { updated: boolean; entries: PromptQueueEntryView[] } {
    const session = this.runtime.requireSession(params.sessionId);
    const updated = session.promptQueue.beginEdit(params.id);
    const entries = session.promptQueue.list();
    if (updated) this.notifyPromptQueue(params.sessionId, entries, client);
    return { updated, entries };
  }

  updateQueuedPrompt(
    params: UpdateQueuedPromptParams,
    client?: acp.AgentContext,
  ): { updated: boolean; entries: PromptQueueEntryView[] } {
    const session = this.runtime.requireSession(params.sessionId);
    const updated = session.promptQueue.update(params.id, {
      text: params.text,
      prompt: params.prompt,
      editing: params.editing,
      expectedVersion: params.expectedVersion,
    });
    const entries = session.promptQueue.list();
    if (updated) this.notifyPromptQueue(params.sessionId, entries, client);
    return { updated, entries };
  }

  removeQueuedPrompt(
    params: QueueEntryParams,
    client?: acp.AgentContext,
  ): { removed: boolean; entries: PromptQueueEntryView[] } {
    const session = this.runtime.requireSession(params.sessionId);
    const removed = session.promptQueue.remove(params.id);
    const entries = session.promptQueue.list();
    if (removed) this.notifyPromptQueue(params.sessionId, entries, client);
    return { removed, entries };
  }

  clearPromptQueue(
    params: QueueSessionParams,
    client?: acp.AgentContext,
  ): { cleared: number; entries: PromptQueueEntryView[] } {
    const session = this.runtime.requireSession(params.sessionId);
    const cleared = session.promptQueue.clear();
    const entries = session.promptQueue.list();
    if (cleared) this.notifyPromptQueue(params.sessionId, entries, client);
    return { cleared, entries };
  }

  takeNextQueuedPrompt(
    params: QueueSessionParams,
    client?: acp.AgentContext,
  ): PromptQueueEntry | null {
    const session = this.runtime.requireSession(params.sessionId);
    const entry = session.promptQueue.takeNext();
    if (entry) {
      this.notifyPromptQueue(
        params.sessionId,
        session.promptQueue.list(),
        client,
      );
    }
    return entry;
  }

  async takeSteeringMessages(
    params: QueueSessionParams,
    client: acp.AgentContext,
  ): Promise<ChatMessage[]> {
    const session = this.runtime.requireSession(params.sessionId);
    const steering = session.promptQueue.takeSteering();
    if (!steering.length) return [];

    await this.notifyPromptQueue(
      params.sessionId,
      session.promptQueue.list(),
      client,
    );
    for (const entry of steering) {
      await client
        .notify("session/update", {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "user_message_chunk",
            content: { type: "text", text: entry.text },
          },
        })
        .catch(() => {
          // Steering remains model-visible if the client disconnects between
          // queue removal and transcript notification.
        });
    }
    return steering.map((entry) => ({
      role: "user" as const,
      content: contentBlocksToNovaContent(frameSteeringPrompt(entry.prompt)),
    }));
  }

  notifyPromptQueue(
    sessionId: string,
    entries: PromptQueueEntryView[],
    client?: acp.AgentContext,
  ): Promise<void> {
    if (!client) return Promise.resolve();
    return client.notify(NOVA_NOTIFICATIONS.queueChanged, { sessionId, entries }).catch(() => {
      // Queue ownership and ordering remain valid if a client disconnects or
      // does not understand this Nova extension notification.
    });
  }
}
