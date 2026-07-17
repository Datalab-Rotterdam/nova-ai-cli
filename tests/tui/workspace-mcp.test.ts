import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readWorkspaceMcpConfiguration } from "../../src/tui/settings/workspace-mcp.js";

test("project .mcp.json servers are normalized and override workspace settings by name", () => {
  const cwd = mkdtempSync(join(tmpdir(), "nova-project-mcp-"));
  try {
    mkdirSync(join(cwd, ".nova-ai"));
    writeFileSync(join(cwd, ".nova-ai", "settings.json"), JSON.stringify({
      mcpServers: [
        { name: "shared", command: "old-command", args: [], env: [] },
        { name: "settings-only", command: "settings-command", args: [], env: [] },
      ],
    }));
    writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({
      mcpServers: {
        shared: {
          type: "stdio",
          command: "new-command",
          args: ["--project"],
          env: { PROJECT_TOKEN: "secret" },
        },
        remote: {
          type: "http",
          url: "https://mcp.example.test/rpc",
          headers: { Authorization: "Bearer hidden" },
        },
        disabled: { command: "ignored", disabled: true },
        broken: { type: "stdio", args: ["missing-command"] },
      },
    }));

    const configuration = readWorkspaceMcpConfiguration(cwd);
    assert.deepEqual(configuration.servers.map((server) => server.name), ["shared", "settings-only", "remote"]);

    const shared = configuration.servers.find((server) => server.name === "shared");
    assert.ok(shared && "command" in shared);
    assert.equal(shared.command, "new-command");
    assert.deepEqual(shared.args, ["--project"]);
    assert.deepEqual(shared.env, [{ name: "PROJECT_TOKEN", value: "secret" }]);

    const remote = configuration.servers.find((server) => server.name === "remote");
    assert.ok(remote && "type" in remote && remote.type === "http");
    assert.deepEqual(remote.headers, [{ name: "Authorization", value: "Bearer hidden" }]);
    assert.deepEqual(configuration.failures, [{
      serverName: ".mcp.json:broken",
      message: "Invalid server configuration: stdio server requires a command.",
    }]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("an invalid project .mcp.json is reported without hiding settings servers", () => {
  const cwd = mkdtempSync(join(tmpdir(), "nova-invalid-project-mcp-"));
  try {
    mkdirSync(join(cwd, ".nova-ai"));
    writeFileSync(join(cwd, ".nova-ai", "settings.json"), JSON.stringify({
      mcpServers: [{ name: "valid", command: "valid-command", args: [], env: [] }],
    }));
    writeFileSync(join(cwd, ".mcp.json"), "{ not valid JSON");

    const configuration = readWorkspaceMcpConfiguration(cwd);
    assert.deepEqual(configuration.servers.map((server) => server.name), ["valid"]);
    assert.equal(configuration.failures.length, 1);
    assert.equal(configuration.failures[0]?.serverName, ".mcp.json");
    assert.match(configuration.failures[0]?.message ?? "", /^Invalid JSON:/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
