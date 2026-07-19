import assert from "node:assert/strict";
import test from "node:test";
import type { ChatMessage, NovaAI } from "@datalabrotterdam/nova-sdk";
import {
  COMPACTION_SUMMARY_PREFIX,
  compactConversation,
  contextWindowFromError,
  isContextLimitError,
} from "../../src/core/context-compaction.js";

const overflowMessage =
  "This model's maximum context length is 262144 tokens. However, you requested 0 output tokens and your prompt contains at least 262145 input tokens, for a total of at least 262145 tokens. Please reduce the length of the input prompt or the number of requested output tokens. (parameter=input_tokens, value=262145)";

test("the Nova maximum-context response is recognized and exposes its token limit", () => {
  const error = Object.assign(new Error(overflowMessage), { status: 400 });
  assert.equal(isContextLimitError(error), true);
  assert.equal(contextWindowFromError(error), 262_144);
  assert.equal(
    isContextLimitError(
      Object.assign(new Error("invalid model"), { status: 400 }),
    ),
    false,
  );
});

test("conversation compaction summarizes older messages and preserves recent context", async () => {
  const history: ChatMessage[] = Array.from({ length: 12 }, (_, index) => ({
    role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
    content: `message-${index + 1}`,
  }));
  let summarySource = "";
  const novaClient = {
    chat: {
      completions: {
        create: async (request: { messages: ChatMessage[] }) => {
          summarySource += String(request.messages[1]?.content ?? "");
          return {
            choices: [
              {
                message: {
                  role: "assistant",
                  content: "Durable summary of earlier work.",
                },
              },
            ],
          };
        },
      },
    },
  } as unknown as NovaAI;

  const result = await compactConversation(history, novaClient, "test-model", {
    contextWindow: 262_144,
  });

  assert.equal(result.compacted, true);
  assert.equal(result.removedMessages, 8);
  assert.equal(result.keptMessages, 4);
  assert.equal(result.history.length, 5);
  assert.match(
    String(result.history[0]?.content),
    new RegExp(`^\\${COMPACTION_SUMMARY_PREFIX}`),
  );
  assert.deepEqual(result.history.slice(1), history.slice(-4));
  assert.match(summarySource, /message-1/);
  assert.doesNotMatch(summarySource, /message-12/);
});

test("a blank completion is retried once before compaction gives up", async () => {
  const history: ChatMessage[] = Array.from({ length: 4 }, (_, index) => ({
    role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
    content: `message-${index + 1}`,
  }));
  let calls = 0;
  const novaClient = {
    chat: {
      completions: {
        create: async () => {
          calls++;
          return {
            choices: [
              {
                message: {
                  role: "assistant",
                  content: calls === 1 ? "   " : "Durable summary.",
                },
              },
            ],
          };
        },
      },
    },
  } as unknown as NovaAI;

  const result = await compactConversation(history, novaClient, "test-model", {
    contextWindow: 262_144,
  });

  assert.equal(calls, 2);
  assert.equal(result.compacted, true);
  assert.match(String(result.history[0]?.content), /Durable summary\./);
});

test("a completion that is only reasoning is treated as empty and widens the retry budget", async () => {
  const history: ChatMessage[] = Array.from({ length: 4 }, (_, index) => ({
    role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
    content: `message-${index + 1}`,
  }));
  const seenMaxTokens: Array<number | undefined> = [];
  const novaClient = {
    chat: {
      completions: {
        create: async (request: { max_tokens?: number }) => {
          seenMaxTokens.push(request.max_tokens);
          const first = seenMaxTokens.length === 1;
          return {
            choices: [
              {
                message: {
                  role: "assistant",
                  // A reasoning model that exhausted its token budget mid-thought:
                  // the unterminated <think> block leaves nothing visible.
                  content: first
                    ? "<think>weighing what to keep from this history..."
                    : "<think>brief</think>Durable summary.",
                },
              },
            ],
          };
        },
      },
    },
  } as unknown as NovaAI;

  const result = await compactConversation(history, novaClient, "test-model", {
    contextWindow: 32_768,
  });

  assert.equal(result.compacted, true);
  assert.match(String(result.history[0]?.content), /Durable summary\./);
  assert.doesNotMatch(String(result.history[0]?.content), /<think>/);
  assert.equal(seenMaxTokens.length, 2);
  assert.ok(
    (seenMaxTokens[1] ?? 0) > (seenMaxTokens[0] ?? 0),
    "retry should request a wider token budget than the first attempt",
  );
});

test("compaction throws when every attempt returns a blank completion", async () => {
  const history: ChatMessage[] = Array.from({ length: 4 }, (_, index) => ({
    role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
    content: `message-${index + 1}`,
  }));
  const novaClient = {
    chat: {
      completions: {
        create: async () => ({
          choices: [{ message: { role: "assistant", content: "" } }],
        }),
      },
    },
  } as unknown as NovaAI;

  await assert.rejects(
    compactConversation(history, novaClient, "test-model", {
      contextWindow: 262_144,
    }),
    /Nova AI returned an empty context-compaction summary\./,
  );
});
