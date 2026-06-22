import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type * as acp from "@agentclientprotocol/sdk";
import { readFileTool } from "../../../src/acp/tools/read-file.js";
import type { ToolContext } from "../../../src/acp/tools/types.js";

function makeContext(request: (method: string, params: unknown) => Promise<unknown>): ToolContext {
  return {
    client: { request } as unknown as acp.AgentContext,
    sessionId: "session-1",
    signal: new AbortController().signal,
  };
}

describe("readFileTool", () => {
  it("errors without calling the client when path is missing", async () => {
    let called = false;
    const ctx = makeContext(async () => {
      called = true;
      return {};
    });

    const result = await readFileTool.execute(ctx, {});

    assert.deepEqual(result, { error: "read_file requires a 'path' argument." });
    assert.equal(called, false);
  });

  it("requests fs/read_text_file and returns the content", async () => {
    const ctx = makeContext(async (method, params) => {
      assert.equal(method, "fs/read_text_file");
      assert.deepEqual(params, { sessionId: "session-1", path: "/tmp/x" });
      return { content: "hello" };
    });

    const result = await readFileTool.execute(ctx, { path: "/tmp/x" });

    assert.deepEqual(result, { output: "hello" });
  });

  it("returns an error when the client request rejects", async () => {
    const ctx = makeContext(async () => {
      throw new Error("file not found");
    });

    const result = await readFileTool.execute(ctx, { path: "/tmp/missing" });

    assert.deepEqual(result, { error: "file not found (path tried: /tmp/missing)" });
  });
});
