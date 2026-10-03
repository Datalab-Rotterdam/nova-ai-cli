import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import * as acp from "@agentclientprotocol/sdk";
import { NovaAgent } from "../../src/acp/agent.js";
import { sse, text, withFakeNova } from "./fake-nova.js";

function recordingClient() {
  const updates: Array<Record<string, unknown>> = [];
  const client = {
    notify: async (_method: string, params: { update: Record<string, unknown> }) => void updates.push(params.update),
    request: async () => ({ outcome: { outcome: "cancelled" } }),
  } as unknown as acp.AgentContext;
  const ofKind = (kind: string) => updates.filter((update) => update.sessionUpdate === kind);
  return { client, updates, ofKind };
}

async function start(home: string, client: acp.AgentContext) {
  const agent = new NovaAgent();
  agent.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
  const cwd = join(home, "repo");
  mkdirSync(cwd, { recursive: true });
  const { sessionId } = await agent.newSession({ cwd, mcpServers: [] }, client);
  return { agent, sessionId };
}

const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(check(), "condition not reached");
};

describe("session updates", () => {
  it("announces commands and, once loaded, the model choice after session/new", async () => {
    await withFakeNova(
      () => sse([text("unused")]),
      async (_requests, home) => {
        const { client, ofKind } = recordingClient();
        await start(home, client);
        await until(() => ofKind("config_option_update").length > 0);
        assert.deepEqual(
          (ofKind("available_commands_update")[0]!.availableCommands as Array<{ name: string }>).map((c) => c.name),
          ["compact"],
        );
        const options = ofKind("config_option_update")[0]!.configOptions as Array<{ id: string }>;
        assert.deepEqual(options.map((option) => option.id), ["permission_mode", "model"]);
      },
    );
  });

  it("reports server token usage, title and last activity after a turn", async () => {
    await withFakeNova(
      () =>
        sse([
          text("Hi there."),
          { choices: [], usage: { prompt_tokens: 1200, completion_tokens: 30 } },
        ]),
      async (_requests, home) => {
        const { client, ofKind } = recordingClient();
        const { agent, sessionId } = await start(home, client);
        await agent.prompt({ sessionId, prompt: [{ type: "text", text: "Say hi" }] }, client);
        assert.deepEqual(
          ofKind("usage_update").map((u) => [u.used, u.size, u._meta ?? null]),
          [[1230, 100000, null]],
        );
        const info = ofKind("session_info_update").at(-1)!;
        assert.equal(info.title, "Say hi");
        assert.ok(typeof info.updatedAt === "string");
      },
    );
  });

  it("falls back to an estimated usage when the server reports none", async () => {
    await withFakeNova(
      () => sse([text("Hi.")]),
      async (_requests, home) => {
        const { client, ofKind } = recordingClient();
        const { agent, sessionId } = await start(home, client);
        await agent.prompt({ sessionId, prompt: [{ type: "text", text: "hello" }] }, client);
        const usage = ofKind("usage_update");
        assert.equal(usage.length, 1);
        assert.deepEqual(usage[0]!._meta, { "nova-ai-cli/estimated": true });
        assert.ok((usage[0]!.used as number) > 0);
      },
    );
  });

  it("handles /compact itself instead of sending it to the model", async () => {
    await withFakeNova(
      () => sse([text("should not be called")]),
      async (requests, home) => {
        const { client, ofKind } = recordingClient();
        const { agent, sessionId } = await start(home, client);
        const response = await agent.prompt({ sessionId, prompt: [{ type: "text", text: "/compact" }] }, client);
        assert.deepEqual(response, { stopReason: "end_turn" });
        assert.equal(requests.length, 0);
        assert.match(String((ofKind("agent_message_chunk")[0]!.content as { text: string }).text), /Nothing to compact/);
      },
    );
  });
});
