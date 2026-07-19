import assert from "node:assert/strict";
import test from "node:test";
import type * as acp from "@agentclientprotocol/sdk";
import { NovaAgent } from "../../src/acp/agent.js";
import {
  parseEnqueuePromptParams,
  PromptQueue,
} from "../../src/acp/prompt-queue.js";

test("prompt queue preserves FIFO order while steering can enter at the front", () => {
  const queue = new PromptQueue();
  const followup = queue.enqueue({
    text: "follow up",
    prompt: [{ type: "text", text: "follow up" }],
    kind: "followup",
  });
  const steering = queue.enqueue({
    text: "change direction",
    prompt: [{ type: "text", text: "change direction" }],
    kind: "steer",
    front: true,
  });

  assert.deepEqual(
    queue.list().map(({ id, kind }) => ({ id, kind })),
    [
      { id: steering.id, kind: "steer" },
      { id: followup.id, kind: "followup" },
    ],
  );
  assert.deepEqual(
    queue.takeSteering().map((entry) => entry.text),
    ["change direction"],
  );
  assert.equal(queue.takeNext()?.text, "follow up");
  assert.deepEqual(queue.list(), []);
});

test("an entry being edited cannot be consumed until its content is settled", () => {
  const queue = new PromptQueue();
  const entry = queue.enqueue({
    text: "before",
    prompt: [{ type: "text", text: "before" }],
    kind: "steer",
  });

  assert.equal(queue.beginEdit(entry.id), true);
  assert.deepEqual(queue.takeSteering(), []);
  assert.equal(queue.takeNext(), null);
  assert.equal(
    queue.update(entry.id, {
      text: "after",
      prompt: [{ type: "text", text: "after" }],
      editing: false,
    }),
    true,
  );
  assert.equal(queue.takeSteering()[0]?.prompt[0]?.type, "text");
});

test("NovaAgent drains steering from its session queue and notifies the client", async () => {
  const agent = new NovaAgent();
  const { sessionId } = await agent.newSession({
    cwd: "/repo",
    mcpServers: [],
  });
  const notifications: Array<{ method: string; params: unknown }> = [];
  const client = {
    request: async () => ({}),
    notify: async (method: string, params: unknown) => {
      notifications.push({ method, params });
    },
  } as unknown as acp.AgentContext;

  agent.queuePrompt({
    sessionId,
    text: "steer visibly",
    prompt: [
      { type: "text", text: "steer model content" },
      { type: "image", mimeType: "image/png", data: "YWJj" },
    ],
    kind: "steer",
  });
  agent.queuePrompt({
    sessionId,
    text: "later",
    prompt: [{ type: "text", text: "later" }],
    kind: "followup",
  });

  const steering = await agent.takeSteeringMessages({ sessionId }, client);

  assert.deepEqual(steering, [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: "The user sent this message while you were still working on the current task:\n\n<steering_message>",
        },
        { type: "text", text: "steer model content" },
        {
          type: "image_url",
          image_url: { url: "data:image/png;base64,YWJj" },
        },
        {
          type: "text",
          text: "</steering_message>\n\nThis is guidance for the task already in progress, not a new unrelated request. Incorporate it and continue.",
        },
      ],
    },
  ]);
  assert.deepEqual(
    agent.listPromptQueue({ sessionId }).entries.map((entry) => entry.text),
    ["later"],
  );
  assert.deepEqual(
    notifications.map((notification) => notification.method),
    ["queue/changed", "session/update"],
  );
});

test("queue extension parameters reject malformed content", () => {
  assert.throws(
    () =>
      parseEnqueuePromptParams({
        sessionId: "session",
        text: "hello",
        prompt: [],
        kind: "later",
      }),
    /kind must be either/,
  );
  assert.throws(
    () =>
      parseEnqueuePromptParams({
        sessionId: "session",
        text: "hello",
        prompt: "hello",
      }),
    /prompt must be an array/,
  );
});
