import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import * as acp from "@agentclientprotocol/sdk";
import { NovaAgent } from "../../src/acp/agent.js";
import { expandCommand } from "../../src/core/command-files.js";
import { sse, text, withFakeNova } from "../../../../test-support/fake-nova.js";

test("expandCommand fills $ARGUMENTS and $1…$9, or appends the arguments", () => {
  assert.equal(expandCommand({ prompt: "Fix $1 in $2; all: $ARGUMENTS" }, "bug a.ts"), "Fix bug in a.ts; all: bug a.ts");
  assert.equal(expandCommand({ prompt: "Review." }, "a.ts"), "Review.\n\na.ts");
  assert.equal(expandCommand({ prompt: "Review." }, ""), "Review.");
});

test("command files are advertised and a /command prompt becomes the file's text with its model", async () => {
  const models = ["fake-model", "other-model"].map((id) => ({ id, object: "model", created: 0, owned_by: "x", context_window: 100000 }));
  await withFakeNova(
    () => sse([text("Done.")]),
    async (requests, home) => {
      const cwd = join(home, "repo");
      mkdirSync(join(home, "commands"), { recursive: true });
      mkdirSync(join(cwd, ".nova-ai", "commands", "git"), { recursive: true });
      writeFileSync(join(home, "commands", "review.md"), "---\ndescription: Review a file\nargument-hint: <file>\nmodel: other-model\n---\nReview $1 carefully.");
      writeFileSync(join(cwd, ".nova-ai", "commands", "git", "pr.md"), "Open a pull request.");
      writeFileSync(join(cwd, ".nova-ai", "commands", "compact.md"), "Never used: the built-in wins.");

      const updates: acp.SessionUpdate[] = [];
      const client = {
        notify: async (_method: string, params: { update: acp.SessionUpdate }) => void updates.push(params.update),
        request: async () => ({ outcome: { outcome: "cancelled" } }),
      } as unknown as acp.AgentContext;
      const agent = new NovaAgent();
      agent.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
      const { sessionId } = await agent.newSession({ cwd, mcpServers: [] }, client);
      const commands = async () => {
        for (let i = 0; i < 100 && !updates.some((u) => u.sessionUpdate === "available_commands_update"); i++) {
          await new Promise((done) => setTimeout(done, 10));
        }
        const update = updates.find((u) => u.sessionUpdate === "available_commands_update");
        return update?.sessionUpdate === "available_commands_update" ? update.availableCommands : [];
      };
      assert.deepEqual(await commands(), [
        { name: "compact", description: "Summarize older parts of the conversation to free context space" },
        { name: "git:pr", description: "Open a pull request." },
        { name: "review", description: "Review a file", input: { hint: "<file>" } },
      ]);

      await agent.prompt({ sessionId, prompt: [{ type: "text", text: "/review src/a.ts" }] }, client);
      assert.equal(requests[0]!.body.model, "other-model");
      const sent = JSON.stringify(requests[0]!.body.messages);
      assert.ok(sent.includes("Review src/a.ts carefully.") && !sent.includes("/review"));

      await agent.prompt({ sessionId, prompt: [{ type: "text", text: "/git:pr" }] }, client);
      assert.equal(requests[1]!.body.model, "fake-model");
      assert.ok(JSON.stringify(requests[1]!.body.messages).includes("Open a pull request."));

      await agent.prompt({ sessionId, prompt: [{ type: "text", text: "/unknown thing" }] }, client);
      assert.ok(JSON.stringify(requests[2]!.body.messages).includes("/unknown thing"));
    },
    models,
  );
});
