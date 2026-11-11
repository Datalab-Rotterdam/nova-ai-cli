import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { SessionRunner } from "../../src/tui/session/session-runner.js";
import { createStore } from "../../src/tui/state/store.js";
import type { UIState } from "../../src/tui/state/types.js";
import { sse, text, withFakeNova } from "../../../../test-support/fake-nova.js";
import { setWorkspaceTrusted } from "@datalabrotterdam/nova-ai-agent/core/nova-home.js";

function state(cwd: string): UIState {
  return {
    messages: [],
    plan: [],
    pendingPermission: null,
    pendingQuestion: null,
    inputHistory: [],
    busy: false,
    mode: "chat",
    permissionMode: "ask",
    interactionMode: "agent",
    sessionId: "pending",
    cwd,
    statusLine: null,
    queuedCount: 0,
    contextUsage: null,
    updateAvailable: null,
  };
}

test("the TUI runner talks to the real agent over ACP end to end", async () => {
  await withFakeNova(
    () => sse([text("Hello from Nova.")]),
    async (requests, home) => {
      const cwd = join(home, "repo");
      mkdirSync(cwd, { recursive: true });
      const store = createStore(state(cwd));
      const runner = new SessionRunner(store, { apiKey: "test-key", defaultModel: "fake-model" }, cwd);
      try {
        await runner.submit("hi");
        const transcript = store
          .getState()
          .messages.flatMap((m) => (m.role === "user" || m.role === "assistant" ? [[m.role, m.text]] : []));
        assert.deepEqual(transcript, [
          ["user", "hi"],
          ["assistant", "Hello from Nova."],
        ]);
        assert.equal(requests.length, 1);
        assert.equal(store.getState().busy, false);
        // Context usage now comes from _nova/session/context_usage.
        for (let i = 0; i < 50 && !store.getState().contextUsage; i++) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.ok(store.getState().contextUsage);
      } finally {
        await runner.close();
      }
    },
  );
});

test("the session starts before the first prompt, once, with the workspace's MCP status", async () => {
  await withFakeNova(
    () => sse([text("ok")]),
    async (_requests, home) => {
      const cwd = join(home, "repo");
      mkdirSync(cwd, { recursive: true });
      setWorkspaceTrusted(cwd, true);
      writeFileSync(
        join(cwd, ".mcp.json"),
        JSON.stringify({ mcpServers: { local: { command: "nova-ai-definitely-missing-mcp-command" } } }),
      );
      const runner = new SessionRunner(createStore(state(cwd)), { apiKey: "test-key", defaultModel: "fake-model" }, cwd);
      const nova = (runner as unknown as { nova: { newSession(...args: unknown[]): Promise<unknown> } }).nova;
      let created = 0;
      const newSession = nova.newSession.bind(nova);
      nova.newSession = (...args) => {
        created++;
        return newSession(...args);
      };
      try {
        await Promise.all([runner.prepareSession(), runner.prepareSession(), runner.submit("hi")]);
        assert.equal(created, 1);
        assert.deepEqual(runner.mcpSessionStatus().configured.map((server) => server.name), ["local"]);
      } finally {
        await runner.close();
      }
    },
  );
});
