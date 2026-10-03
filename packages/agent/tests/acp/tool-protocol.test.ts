import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import * as acp from "@agentclientprotocol/sdk";
import { NovaAgent } from "../../src/acp/agent.js";

type Captured = { url: string; body: Record<string, unknown> };

function sse(chunks: Array<Record<string, unknown>>): Response {
  const body =
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") +
    "data: [DONE]\n\n";
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

async function withFakeNova(
  respond: (captured: Captured, index: number) => Response,
  run: (requests: Captured[], home: string) => Promise<void>,
): Promise<void> {
  const previous = {
    fetch: globalThis.fetch,
    apiKey: process.env.NOVA_API_KEY,
    model: process.env.NOVA_MODEL,
    home: process.env.NOVA_AI_HOME,
    sessions: process.env.NOVA_AI_CLI_SESSIONS_DIR,
  };
  const home = mkdtempSync(join(tmpdir(), "nova-protocol-"));
  process.env.NOVA_API_KEY = "test-key";
  process.env.NOVA_MODEL = "plain-model";
  process.env.NOVA_AI_HOME = home;
  process.env.NOVA_AI_CLI_SESSIONS_DIR = join(home, "sessions");
  const requests: Captured[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/models")) {
      return new Response(
        JSON.stringify({ object: "list", data: [{ id: "plain-model", object: "model", created: 0, owned_by: "x", context_window: 100000 }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    const captured = { url, body: JSON.parse(String(init?.body)) as Record<string, unknown> };
    requests.push(captured);
    return respond(captured, requests.length - 1);
  }) as typeof fetch;
  try {
    await run(requests, home);
  } finally {
    globalThis.fetch = previous.fetch;
    for (const [key, value] of [
      ["NOVA_API_KEY", previous.apiKey],
      ["NOVA_MODEL", previous.model],
      ["NOVA_AI_HOME", previous.home],
      ["NOVA_AI_CLI_SESSIONS_DIR", previous.sessions],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
  }
}

const client = {
  notify: async () => {},
  request: async () => ({ outcome: { outcome: "selected", optionId: "allow" } }),
} as unknown as acp.AgentContext;

async function startSession(agent: NovaAgent, cwd: string): Promise<string> {
  agent.initialize({
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
  });
  const { sessionId } = await agent.newSession({ cwd, mcpServers: [] });
  return sessionId;
}

describe("NovaAgent tool protocol selection", () => {
  it("falls back to the text protocol when the server rejects native tools, and remembers it", async () => {
    await withFakeNova(
      (captured) =>
        captured.body.tools
          ? new Response(
              JSON.stringify({ error: { message: "This model does not support tools", type: "invalid_request_error" } }),
              { status: 400, headers: { "content-type": "application/json" } },
            )
          : sse([{ choices: [{ delta: { content: "Plain answer." }, finish_reason: "stop" }] }]),
      async (requests, home) => {
        const agent = new NovaAgent();
        const sessionId = await startSession(agent, home);

        const first = await agent.prompt(
          { sessionId, prompt: [{ type: "text", text: "hello" }] },
          client,
        );
        assert.equal(first.stopReason, "end_turn");
        assert.equal(requests.length, 2);
        assert.ok(requests[0]!.body.tools, "native attempt first");
        assert.equal(requests[1]!.body.tools, undefined);
        const system = (requests[1]!.body.messages as Array<{ role: string; content: string }>)[0]!;
        assert.equal(system.role, "system");
        assert.match(system.content, /```tool_call/);

        const stored = JSON.parse(readFileSync(join(home, "model-capabilities.json"), "utf8"));
        assert.deepEqual(stored, { "plain-model": "unsupported" });

        // The next turn goes straight to the text protocol.
        await agent.prompt({ sessionId, prompt: [{ type: "text", text: "again" }] }, client);
        assert.equal(requests.length, 3);
        assert.equal(requests[2]!.body.tools, undefined);
      },
    );
  });

  it("uses native tools without teaching the text protocol", async () => {
    await withFakeNova(
      () => sse([{ choices: [{ delta: { content: "Native answer." }, finish_reason: "stop" }] }]),
      async (requests, home) => {
        const agent = new NovaAgent();
        const sessionId = await startSession(agent, home);
        await agent.prompt({ sessionId, prompt: [{ type: "text", text: "hello" }] }, client);
        assert.equal(requests.length, 1);
        assert.ok(Array.isArray(requests[0]!.body.tools));
        const system = (requests[0]!.body.messages as Array<{ role: string; content: string }>)[0]!;
        assert.doesNotMatch(system.content, /```tool_call/);
        assert.match(system.content, /workspace root is/);
      },
    );
  });
});
