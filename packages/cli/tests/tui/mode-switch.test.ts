import assert from "node:assert/strict";
import test from "node:test";
import { TuiAcpClient } from "../../src/tui/session/tui-acp-client.js";
import { SessionRunner } from "../../src/tui/session/session-runner.js";
import { createStore } from "../../src/tui/state/store.js";
import type { UIState } from "../../src/tui/state/types.js";
import { formatCost, formatUsageTotals } from "../../src/tui/ink/format.js";

function state(): UIState {
  return {
    messages: [],
    plan: [],
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
    updateAvailable: null,
  };
}

test("an autonomous ACP mode update changes interaction mode but never permission mode", async () => {
  const store = createStore(state());
  const client = new TuiAcpClient(store, process.cwd(), undefined, (mode) =>
    store.setState({ interactionMode: mode }),
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

test("a mode from one of the user's agent files is taken once the agent listed it", async () => {
  const store = createStore(state());
  const client = new TuiAcpClient(store, process.cwd(), undefined, (mode) =>
    store.setState({ interactionMode: mode }),
  );
  const update = { sessionId: "session-1", update: { sessionUpdate: "current_mode_update" as const, currentModeId: "reviewer" } };
  await client.sessionUpdate(update);
  assert.equal(store.getState().interactionMode, "agent");
  client.modeIds = ["agent", "ask", "plan", "reviewer"];
  await client.sessionUpdate(update);
  assert.equal(store.getState().interactionMode, "reviewer");
});

test("the agent's slash commands are kept with their input hint", async () => {
  const client = new TuiAcpClient(createStore(state()), process.cwd());
  await client.sessionUpdate({
    sessionId: "session-1",
    update: {
      sessionUpdate: "available_commands_update",
      availableCommands: [
        { name: "review", description: "Review a file", input: { hint: "<file>" } },
        { name: "git:pr", description: "Open a pull request." },
      ],
    },
  });
  assert.deepEqual(client.agentCommands, [
    { name: "review", description: "Review a file", hint: "<file>" },
    { name: "git:pr", description: "Open a pull request." },
  ]);
});

test("the session's usage totals are kept from the agent's usage updates", async () => {
  const store = createStore(state());
  const client = new TuiAcpClient(store, process.cwd());
  const totals = { promptTokens: 12_300, completionTokens: 450, cachedTokens: 1_000, cost: 0.01234, currency: "EUR" };
  await client.sessionUpdate({
    sessionId: "session-1",
    update: { sessionUpdate: "usage_update", used: 12_750, size: 100_000, cost: { amount: 0.01234, currency: "EUR" }, _meta: { "nova-ai-cli/usageTotals": totals } },
  });
  assert.deepEqual(store.getState().usageTotals, totals);
  assert.equal(formatCost(0.01234), "€0.0123");
  assert.equal(formatCost(12.5, "USD"), "$12.50");
  assert.match(formatUsageTotals(totals), /^This session: 12k in \(1k cached\) · 450 out · ≈ €0\.0123/);
});
