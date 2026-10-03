import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import * as acp from "@agentclientprotocol/sdk";
import { startAcpProcess } from "./acp-process.js";

describe("nova-ai --acp as a process", () => {
  it("advertises Nova extensions, serves them under _nova/ and exits on stdin EOF", async () => {
    const agent = startAcpProcess();
    try {
      const init = await agent.connection.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const pkg = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8"));
      assert.deepEqual(init.agentInfo, { name: "nova-ai-cli", title: "Nova AI", version: pkg.version });
      assert.equal(init.protocolVersion, 1);
      assert.deepEqual(
        init.authMethods?.map((method) => ("type" in method && method.type ? method.type : "agent")),
        ["agent", "env_var"],
      );
      const meta = init.agentCapabilities?._meta?.["nova-ai-cli"] as { methods: string[]; notifications: string[] };
      assert.ok(meta.methods.every((name) => name.startsWith("_nova/")));
      assert.ok(meta.notifications.every((name) => name.startsWith("_nova/")));
      assert.ok(meta.methods.includes("_nova/background/list"));

      const listed = await agent.connection.extMethod("_nova/background/list", {});
      assert.deepEqual(listed, { jobs: [] });

      await assert.rejects(
        agent.connection.extMethod("background/list", {}),
        (error: unknown) => (error as { code?: number }).code === -32601,
      );
    } finally {
      assert.equal(await agent.close(), 0);
    }
    for (const line of agent.stdoutLines) {
      assert.equal(JSON.parse(line).jsonrpc, "2.0", `stdout must only carry JSON-RPC: ${line}`);
    }
  });
});
