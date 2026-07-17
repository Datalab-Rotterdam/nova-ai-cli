import assert from "node:assert/strict";
import test from "node:test";
import { TuiAcpClient } from "../../src/tui/session/tui-acp-client.js";
import { SessionRunner } from "../../src/tui/session/session-runner.js";
import { createStore } from "../../src/tui/state/store.js";
import type { UIState } from "../../src/tui/state/types.js";

function state(): UIState {
  return {
    messages: [],
    pendingPermission: null,
    pendingQuestion: null,
    inputHistory: [],
    busy: true,
    mode: "chat",
    permissionMode: "ask",
    interactionMode: "agent",
    sessionId: "session-1",
    cwd: process.cwd(),
    statusLine: null,
    queuedCount: 0,
    contextUsage: null,
  };
}

test("an autonomous ACP mode update changes interaction mode but never permission mode", async () => {
  const store = createStore(state());
  const client = new TuiAcpClient(
    store,
    process.cwd(),
    undefined,
    (mode) => store.setState({ interactionMode: mode }),
  );

  await client.sessionUpdate({
    sessionId: "session-1",
    update: {
      sessionUpdate: "current_mode_update",
      currentModeId: "plan",
    },
  });

  assert.equal(store.getState().interactionMode, "plan");
  assert.equal(store.getState().permissionMode, "ask");

  await client.sessionUpdate({
    sessionId: "session-1",
    update: {
      sessionUpdate: "current_mode_update",
      currentModeId: "bypassAll",
    },
  });

  assert.equal(store.getState().interactionMode, "plan");
  assert.equal(store.getState().permissionMode, "ask");
});

test("session runner applies the agent's autonomous plan transition to the footer state", async () => {
  const store = createStore(state());
  const runner = new SessionRunner(
    store,
    { apiKey: "test", defaultModel: "test-model" },
    process.cwd(),
  );
  const internals = runner as unknown as { acpClient: TuiAcpClient };

  await internals.acpClient.sessionUpdate({
    sessionId: runner.sessionId,
    update: {
      sessionUpdate: "current_mode_update",
      currentModeId: "plan",
    },
  });

  assert.equal(runner.interactionMode, "plan");
  assert.equal(store.getState().interactionMode, "plan");
  assert.equal(store.getState().permissionMode, "ask");
  assert.equal(store.getState().statusLine, "Agent switched to plan mode.");
});
