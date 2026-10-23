import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import * as acp from "@agentclientprotocol/sdk";
import { NovaAgent } from "../../src/acp/agent.js";
import { loadStoredSession } from "../../src/core/sessions.js";
import { sse, text, withFakeNova } from "../../../../test-support/fake-nova.js";

const client = {
  notify: async () => {},
  request: async () => ({ outcome: { outcome: "cancelled" } }),
} as unknown as acp.AgentContext;

async function start(home: string): Promise<{ agent: NovaAgent; sessionId: string }> {
  const agent = new NovaAgent();
  agent.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
  const cwd = join(home, "repo");
  mkdirSync(cwd, { recursive: true });
  const { sessionId } = await agent.newSession({ cwd, mcpServers: [] });
  return { agent, sessionId };
}

const ask = (agent: NovaAgent, sessionId: string, value: string) =>
  agent.prompt({ sessionId, prompt: [{ type: "text", text: value }] }, client);

describe("prompt lifecycle", () => {
  it("a new prompt cancels the running one and turns are saved one after the other", async () => {
    await withFakeNova(
      (request, index) =>
        index === 0 ? sse([], { holdUntilAborted: request.signal }) : sse([text("Second answer.")]),
      async (requests, home) => {
        const { agent, sessionId } = await start(home);
        const first = ask(agent, sessionId, "first");
        while (requests.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
        const second = ask(agent, sessionId, "second");
        assert.deepEqual(await first, { stopReason: "cancelled" });
        assert.deepEqual(await second, { stopReason: "end_turn" });
        const messages = loadStoredSession(sessionId)!.messages.map((m) => [m.role, m.content]);
        assert.deepEqual(messages, [
          ["user", "first"],
          ["user", "second"],
          ["assistant", "Second answer."],
        ]);
      },
    );
  });

  it("session/cancel ends the running turn with stopReason cancelled", async () => {
    await withFakeNova(
      (request) => sse([], { holdUntilAborted: request.signal }),
      async (requests, home) => {
        const { agent, sessionId } = await start(home);
        const running = ask(agent, sessionId, "long task");
        while (requests.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
        agent.cancel({ sessionId });
        assert.deepEqual(await running, { stopReason: "cancelled" });
      },
    );
  });

  it("deleting a session during a turn leaves no file behind", async () => {
    await withFakeNova(
      (request) => sse([], { holdUntilAborted: request.signal }),
      async (requests, home) => {
        const { agent, sessionId } = await start(home);
        const running = ask(agent, sessionId, "work");
        while (requests.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
        await agent.deleteSession({ sessionId });
        await running;
        assert.equal(loadStoredSession(sessionId), null);
        assert.ok(!existsSync(join(home, "sessions", `${sessionId}.jsonl`)));
      },
    );
  });

  it("reports unknown sessions as -32002 and a rejected key as auth_required", async () => {
    await withFakeNova(
      () => new Response(JSON.stringify({ error: { message: "invalid api key" } }), { status: 401, headers: { "content-type": "application/json" } }),
      async (_requests, home) => {
        const { agent, sessionId } = await start(home);
        await assert.rejects(ask(agent, "nope", "x"), (error: unknown) => (error as acp.RequestError).code === -32002);
        await assert.rejects(ask(agent, sessionId, "x"), (error: unknown) => (error as acp.RequestError).code === acp.RequestError.authRequired().code);
      },
    );
  });

  it("shutdown cancels running turns", async () => {
    await withFakeNova(
      (request) => sse([], { holdUntilAborted: request.signal }),
      async (requests, home) => {
        const { agent, sessionId } = await start(home);
        const running = ask(agent, sessionId, "work");
        while (requests.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
        await agent.shutdown();
        assert.deepEqual(await running, { stopReason: "cancelled" });
      },
    );
  });
});

describe("thinking effort", () => {
  const thinkingModel = {
    id: "fake-model",
    object: "model",
    created: 0,
    owned_by: "x",
    reasoning_efforts: ["low", "medium", "high"],
  };

  it("sends the chosen level, the model's default for an unknown one, and none for other models", async () => {
    await withFakeNova(
      () => sse([text("ok")]),
      async (requests, home) => {
        const { agent, sessionId } = await start(home);
        await ask(agent, sessionId, "default");
        await agent.setSessionConfigOption({ sessionId, configId: "thought_level", value: "high" });
        await ask(agent, sessionId, "chosen");
        await agent.prompt(
          { sessionId, prompt: [{ type: "text", text: "per prompt" }], _meta: { "nova-ai-cli/effort": "bogus" } },
          client,
        );
        assert.deepEqual(
          requests.map((request) => request.body.reasoning_effort),
          ["medium", "high", "medium"],
        );
        const options = await agent.setSessionConfigOption({ sessionId, configId: "thought_level", value: "low" });
        const level = options.configOptions.find((option) => option.id === "thought_level");
        assert.equal(level?.type === "select" ? level.currentValue : null, "low");
      },
      [thinkingModel],
    );
    await withFakeNova(
      () => sse([text("ok")]),
      async (requests, home) => {
        const { agent, sessionId } = await start(home);
        await ask(agent, sessionId, "plain model");
        assert.equal("reasoning_effort" in requests[0]!.body, false);
      },
    );
  });
});
