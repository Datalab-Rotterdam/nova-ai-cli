import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as acp from "@agentclientprotocol/sdk";
import { NovaAgent } from "../../src/acp/agent.js";
import { buildModeSystemPrompt } from "../../src/core/agent/mode-prompt.js";
import { buildSessionTools } from "../../src/core/agent/session-tools.js";
import { isAutopilot, listAgentFiles } from "../../src/core/agent-files.js";
import { AUTOPILOT_ANSWER } from "../../src/core/interaction-modes.js";
import { novaHomeRoot, projectPaths } from "../../src/core/nova-home.js";

function writeAgent(dir: string, file: string, content: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), content);
}

test("agent files become session modes with their prompt and narrowed tools", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "nova-agent-files-"));
  const global = join(novaHomeRoot(), "agents");
  const project = join(projectPaths(cwd).dir, "agents");
  try {
    writeAgent(global, "Reviewer.agent.md", "---\nname: Global reviewer\n---\nglobal");
    writeAgent(project, "Reviewer.agent.md", "---\nname: Reviewer\ndescription: Reviews without editing\ntools: [read, search, list_dir, mcp]\n---\nReview carefully.");
    writeAgent(project, "scribe.agent.md", "---\nname: Scribe\nreadOnly: true\n---\nWrite nothing.");
    writeAgent(project, "plan.agent.md", "---\nname: Not plan\n---\nignored");
    writeAgent(project, "notes.md", "not an agent file");

    assert.deepEqual(listAgentFiles(cwd).map(({ id, name, source }) => ({ id, name, source })), [
      { id: "reviewer", name: "Reviewer", source: "project" },
      { id: "scribe", name: "Scribe", source: "project" },
    ]);
    assert.equal(buildModeSystemPrompt("reviewer", cwd), "Review carefully.");

    const agent = new NovaAgent();
    agent.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true } });
    const client = { notify: async () => {} } as unknown as acp.AgentContext;
    const { sessionId, modes } = await agent.newSession({ cwd, mcpServers: [] }, client);
    assert.deepEqual(modes?.availableModes.map((mode) => mode.id), ["agent", "ask", "plan", "autopilot", "reviewer", "scribe"]);

    agent.setSessionMode({ sessionId, modeId: "reviewer" });
    const session = agent.requireSession(sessionId);
    const tools = (mode: string) => buildSessionTools(session, agent.clientCapabilities, { mode, updatePlan: () => {} }).map((tool) => tool.name);
    assert.deepEqual(tools("reviewer").sort(), ["find_files", "inspect_environment", "list_directory", "read_file", "search_text", "update_plan"]);
    const scribe = tools("scribe");
    assert.ok(scribe.includes("read_file") && !scribe.includes("write_file") && !scribe.includes("run_command"));
    assert.throws(() => agent.setSessionMode({ sessionId, modeId: "missing" }), /Unknown interaction mode/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(global, { recursive: true, force: true });
    rmSync(projectPaths(cwd).dir, { recursive: true, force: true });
  }
});

test("autopilot answers ask_user itself, also from an agent file", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "nova-autopilot-"));
  const project = join(projectPaths(cwd).dir, "agents");
  try {
    writeAgent(project, "solo.agent.md", "---\nname: Solo\nautopilot: true\n---\nWork alone.");
    const agent = new NovaAgent();
    agent.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true, elicitation: { form: {} } } as acp.ClientCapabilities });
    const { sessionId } = await agent.newSession({ cwd, mcpServers: [] }, { notify: async () => {} } as unknown as acp.AgentContext);
    const session = agent.requireSession(sessionId);
    const askUser = (mode: string) => buildSessionTools(session, agent.clientCapabilities, { mode }).find((tool) => tool.name === "ask_user")!;
    for (const mode of ["autopilot", "solo"]) {
      assert.ok(isAutopilot(cwd, mode));
      const answer = await askUser(mode).execute({} as never, { questions: [{ question: "Which?", options: [] }] });
      assert.deepEqual(answer, { output: AUTOPILOT_ANSWER });
    }
    assert.ok(!isAutopilot(cwd, "agent"));
    assert.ok(!buildSessionTools(session, agent.clientCapabilities, { mode: "autopilot", enterPlanMode: () => {} }).some((tool) => tool.name === "enter_plan_mode"));
    assert.match(buildModeSystemPrompt("autopilot", cwd) ?? "", /autopilot mode/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(projectPaths(cwd).dir, { recursive: true, force: true });
  }
});
