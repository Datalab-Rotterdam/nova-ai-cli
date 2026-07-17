import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateContextUsage,
  estimateTokens,
} from "../../src/core/context-usage.js";

test("context usage separates conversation, agents, thinking, tools, skills, and memory", () => {
  const toolCall =
    '```tool_call\n{"name":"read_file","args":{"path":"README.md"}}\n```';
  const skillCall =
    '```tool_call\n{"name":"load_skill","args":{"name":"review"}}\n```';
  const memoryCall =
    '```tool_call\n{"name":"load_memory","args":{"name":"project-build"}}\n```';
  const usage = calculateContextUsage({
    systemPrompt: "ask-mode instructions",
    toolsPrompt: "available tool definitions",
    skillsPrompt: "available skill catalog",
    memoryPrompt: "available memory catalog",
    contextWindow: 10_000,
    history: [
      { role: "user", content: "Review this project." },
      { role: "assistant", content: `I will inspect it.\n${toolCall}` },
      { role: "user", content: "Tool result: project contents" },
      { role: "assistant", content: skillCall },
      { role: "user", content: "Tool result: skill instructions" },
      { role: "assistant", content: memoryCall },
      { role: "user", content: "Tool result: memory contents" },
      { role: "assistant", content: "The review is complete." },
    ],
  });

  assert.equal(
    usage.categories.system,
    estimateTokens("ask-mode instructions"),
  );
  assert.equal(
    usage.categories.conversation,
    estimateTokens("Review this project."),
  );
  assert.equal(
    usage.categories.thinking,
    estimateTokens("I will inspect it.\n"),
  );
  assert.equal(
    usage.categories.tools,
    estimateTokens("available tool definitions") +
      estimateTokens(toolCall) +
      estimateTokens("Tool result: project contents"),
  );
  assert.equal(
    usage.categories.skills,
    estimateTokens("available skill catalog") +
      estimateTokens(skillCall) +
      estimateTokens("Tool result: skill instructions"),
  );
  assert.equal(
    usage.categories.agents,
    estimateTokens("The review is complete."),
  );
  assert.equal(
    usage.categories.memory,
    estimateTokens("available memory catalog") +
      estimateTokens(memoryCall) +
      estimateTokens("Tool result: memory contents"),
  );
  assert.equal(
    usage.totalTokens,
    Object.values(usage.categories).reduce((sum, value) => sum + value, 0),
  );
  assert.equal(usage.remainingTokens, 10_000 - usage.totalTokens);
  assert.equal(usage.percentUsed, (usage.totalTokens / 10_000) * 100);
});

test("background-agent tool context is attributed to agents", () => {
  const call =
    '```tool_call\n{"name":"start_background_agent","args":{"prompt":"audit"}}\n```';
  const usage = calculateContextUsage({
    history: [
      { role: "assistant", content: call },
      { role: "user", content: "Tool result: background agent started" },
    ],
  });

  assert.equal(usage.categories.tools, 0);
  assert.equal(
    usage.categories.agents,
    estimateTokens(call) +
      estimateTokens("Tool result: background agent started"),
  );
});
