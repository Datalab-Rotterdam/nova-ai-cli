import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import * as acp from "@agentclientprotocol/sdk";
import { NovaAgent } from "../../src/acp/agent.js";
import { replayHistory } from "../../src/core/history.js";
import { appendSessionTurn, readSessionSummary } from "../../src/core/sessions.js";
import { withFakeNova } from "../../../../test-support/fake-nova.js";

describe("replayHistory", () => {
  it("never shows tool results as user messages", () => {
    const items = replayHistory([
      { role: "user", content: "fix it" },
      { role: "assistant", content: 'Reading.\n```tool_call\n{"name":"read_file","args":{"path":"a.ts"}}\n```' },
      { role: "user", content: "Tool result: file body" },
      { role: "user", content: "Tool result: orphan whose call was compacted away" },
      { role: "assistant", content: "Done." },
    ]);
    assert.deepEqual(items, [
      { kind: "user", text: "fix it" },
      { kind: "agent", text: "Reading.\n" },
      { kind: "tool", name: "read_file", args: { path: "a.ts" }, status: "completed", output: "file body" },
      { kind: "agent", text: "Done." },
    ]);
  });
});

describe("session/load and session/list", () => {
  it("replays tool calls with their final status instead of raw tool messages", async () => {
    await withFakeNova(
      () => new Response("unused"),
      async (_requests, home) => {
        const cwd = join(home, "repo");
        mkdirSync(cwd, { recursive: true });
        const sessionId = crypto.randomUUID();
        appendSessionTurn(sessionId, { cwd, title: "t" }, [
          { role: "user", content: "run tests" },
          {
            role: "assistant",
            content: "",
            tool_calls: [{ id: "c1", type: "function", function: { name: "run_command", arguments: '{"command":"npm test"}' } }],
          },
          { role: "tool", tool_call_id: "c1", content: "Tool error: 2 failing" },
          { role: "assistant", content: "Two tests fail." },
        ]);
        const updates: acp.SessionUpdate[] = [];
        const client = {
          notify: async (_m: string, params: { update: acp.SessionUpdate }) => void updates.push(params.update),
        } as unknown as acp.AgentContext;
        const agent = new NovaAgent();
        agent.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
        await agent.loadSession({ sessionId, cwd, mcpServers: [] }, client);
        const replayed = updates.filter((u) => u.sessionUpdate !== "available_commands_update" && u.sessionUpdate !== "config_option_update");
        assert.deepEqual(replayed.map((u) => u.sessionUpdate), ["user_message_chunk", "tool_call", "agent_message_chunk"]);
        const call = replayed[1] as Extract<acp.SessionUpdate, { sessionUpdate: "tool_call" }>;
        assert.equal(call.title, "Run `npm test`");
        assert.equal(call.kind, "execute");
        assert.equal(call.status, "failed");
        assert.match(JSON.stringify(call.content), /2 failing/);
      },
    );
  });

  it("pages session/list with an opaque cursor, newest first", async () => {
    await withFakeNova(
      () => new Response("unused"),
      async (_requests, home) => {
        const cwd = join(home, "repo");
        mkdirSync(cwd, { recursive: true });
        for (let index = 0; index < 55; index++) {
          appendSessionTurn(crypto.randomUUID(), { cwd, title: `s${index}` }, [{ role: "user", content: "x" }]);
        }
        const agent = new NovaAgent();
        const first = agent.listSessions({ cwd });
        assert.equal(first.sessions.length, 50);
        assert.ok(first.nextCursor);
        const second = agent.listSessions({ cwd, cursor: first.nextCursor });
        assert.equal(second.sessions.length, 5);
        assert.equal(second.nextCursor, undefined);
        const ids = new Set([...first.sessions, ...second.sessions].map((s) => s.sessionId));
        assert.equal(ids.size, 55);
        assert.throws(() => agent.listSessions({ cwd, cursor: "garbage" }), (e: unknown) => (e as acp.RequestError).code === -32602);
      },
    );
  });

  it("summarizes a session from its last header and record without parsing the messages", () => {
    const raw = [
      JSON.stringify({ kind: "header", cwd: "/a", title: "old" }),
      JSON.stringify({ kind: "turn", checkpointId: "c", updatedAt: "2026-01-01T00:00:00.000Z", messages: [] }),
      JSON.stringify({ kind: "header", version: 1, cwd: "/a", title: "new" }),
      JSON.stringify({ kind: "turn", checkpointId: "d", updatedAt: "2026-02-01T00:00:00.000Z", messages: [{ role: "user", content: "x".repeat(10_000) }] }),
      '{"kind":"turn","broken',
    ].join("\n");
    assert.deepEqual(readSessionSummary(raw), { cwd: "/a", title: "new", updatedAt: "2026-02-01T00:00:00.000Z" });
  });
});
