import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { requestPermissionIfNeeded } from "../../../src/acp/tools/permission.js";
import { readFileTool } from "../../../src/acp/tools/read-file.js";
import { writeFileTool } from "../../../src/acp/tools/write-file.js";
import type { ToolContext } from "../../../src/acp/tools/types.js";
import { makeToolContext } from "./test-helpers.js";

function makeContext(requestPermission: ToolContext["requestPermission"]): ToolContext {
  return { ...makeToolContext(), requestPermission };
}

describe("requestPermissionIfNeeded", () => {
  it("skips the permission request for non-mutating tools", async () => {
    let called = false;
    const ctx = makeContext(async () => {
      called = true;
      throw new Error("should not be called");
    });

    const allowed = await requestPermissionIfNeeded(ctx, "call-1", readFileTool, { path: "/tmp/x" });

    assert.equal(allowed, true);
    assert.equal(called, false);
  });

  it("allows a mutating tool when the host grants permission", async () => {
    const ctx = makeContext(async () => true);

    const allowed = await requestPermissionIfNeeded(ctx, "call-1", writeFileTool, { path: "/tmp/x", content: "hi" });

    assert.equal(allowed, true);
  });

  it("rejects a mutating tool when the host denies permission", async () => {
    const ctx = makeContext(async () => false);

    const allowed = await requestPermissionIfNeeded(ctx, "call-1", writeFileTool, { path: "/tmp/x", content: "hi" });

    assert.equal(allowed, false);
  });
});
