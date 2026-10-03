import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { SessionRunner } from "../../src/tui/session/session-runner.js";
import { createStore } from "../../src/tui/state/store.js";
import type { UIState } from "../../src/tui/state/types.js";
import { sse, text, withFakeNova } from "../../../../test-support/fake-nova.js";

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
