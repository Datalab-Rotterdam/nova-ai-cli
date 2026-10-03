import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import * as acp from "@agentclientprotocol/sdk";
import { startAcpProcess } from "./acp-process.js";
import { finish, say, startFakeNovaServer, toolCall } from "./fake-nova-server.js";

/**
 * The whole editor journey against the real `nova-ai --acp` process and a
 * real HTTP Nova gateway: what Zed or any other ACP client would see.
 */
describe("ACP conformance (real process, real HTTP gateway)", () => {
  it("runs a tool turn with approval, cancels, reloads, lists and closes cleanly", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "nova-conformance-"));
    writeFileSync(join(workspace, "a.txt"), "hello");
    const nova = await startFakeNovaServer([
      { chunks: [toolCall("c1", "read_file", { path: "a.txt" }), finish("tool_calls")] },
      { chunks: [toolCall("c2", "edit_file", { path: "a.txt", old_string: "hello", new_string: "world" }), finish("tool_calls")] },
      { chunks: [say("Edited a.txt.")] },
      { holdUntilClosed: true },
    ]);
    const permissions: acp.RequestPermissionRequest[] = [];
    const agent = startAcpProcess(
      {
        requestPermission: async (params) => {
          permissions.push(params);
          return { outcome: { outcome: "selected", optionId: "allow_always" } };
        },
        readTextFile: async ({ path }) => ({ content: readFileSync(path, "utf8") }),
        writeTextFile: async ({ path, content }) => {
          writeFileSync(path, content);
          return {};
        },
      },
      { NOVA_API_KEY: "test-key", NOVA_MODEL: "fake-model", NOVA_BASE_URL: nova.url },
    );
    try {
      const { connection, updates } = agent;
      await connection.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
        clientInfo: { name: "conformance-test", version: "1" },
      });
      const { sessionId } = await connection.newSession({ cwd: workspace, mcpServers: [] });

      // 1. A native tool turn: read (no question), edit (one question).
      const turn = await connection.prompt({ sessionId, prompt: [{ type: "text", text: "Change hello to world" }] });
      assert.equal(turn.stopReason, "end_turn");
      assert.equal(readFileSync(join(workspace, "a.txt"), "utf8"), "world");
      assert.equal(permissions.length, 1);
      assert.equal(permissions[0]!.toolCall.title, "Edit a.txt");
      assert.deepEqual(permissions[0]!.options.map((o) => o.optionId), ["allow_once", "allow_session", "allow_always", "reject_once"]);
      assert.deepEqual(permissions[0]!.toolCall.content, [
        { type: "diff", path: join(workspace, "a.txt"), oldText: "hello", newText: "world" },
      ]);
      const toolCalls = updates.filter((u) => u.update.sessionUpdate === "tool_call");
      assert.deepEqual(toolCalls.map((u) => (u.update as { title: string }).title), ["Read a.txt", "Edit a.txt"]);
      assert.ok(nova.requests[0]!.tools, "native tools offered");
      assert.equal((nova.requests[1]!.messages as Array<{ role: string }>).at(-1)!.role, "tool");

      // "Always allow" was saved privately, outside the workspace.
      const projects = join(agent.home, "projects");
      const [project] = (await import("node:fs")).readdirSync(projects);
      const saved = JSON.parse(readFileSync(join(projects, project!, "settings.json"), "utf8"));
      assert.deepEqual(saved.permissions.allow, ["edit_file(a.txt)"]);

      // 2. Cancel a turn the gateway never finishes.
      const hanging = connection.prompt({ sessionId, prompt: [{ type: "text", text: "think forever" }] });
      for (let i = 0; i < 200 && nova.requests.length < 4; i++) await new Promise((r) => setTimeout(r, 10));
      await connection.cancel({ sessionId });
      assert.equal((await hanging).stopReason, "cancelled");

      // 3. Reload: the replay shows the tool calls, not raw tool messages.
      const before = updates.length;
      await connection.loadSession({ sessionId, cwd: workspace, mcpServers: [] });
      const replayed = updates.slice(before).map((u) => u.update);
      assert.ok(replayed.some((u) => u.sessionUpdate === "tool_call" && u.title === "Edit a.txt" && u.status === "completed"));
      assert.ok(!replayed.some((u) => u.sessionUpdate === "user_message_chunk" && JSON.stringify(u).includes("Tool result")));

      // 4. List and close.
      const listed = await connection.listSessions({ cwd: workspace });
      assert.ok(listed.sessions.some((s) => s.sessionId === sessionId));
      await connection.closeSession({ sessionId });
    } finally {
      assert.equal(await agent.close(), 0, "agent exits cleanly on stdin EOF");
      await nova.close();
      rmSync(workspace, { recursive: true, force: true });
    }
    for (const line of agent.stdoutLines) {
      assert.equal(JSON.parse(line).jsonrpc, "2.0", `stdout must only carry JSON-RPC: ${line.slice(0, 200)}`);
    }
  });
});
