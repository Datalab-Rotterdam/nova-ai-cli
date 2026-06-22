import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileTool } from "../../../src/acp/tools/read-file.js";
import { buildToolsSystemPrompt } from "../../../src/acp/tools/system-prompt.js";

describe("buildToolsSystemPrompt", () => {
  it("returns null when there are no tools", () => {
    assert.equal(buildToolsSystemPrompt([], "/workspace"), null);
  });

  it("includes the marker format, the workspace root, and each tool's description", () => {
    const prompt = buildToolsSystemPrompt([readFileTool], "/workspace");
    assert.ok(prompt);
    assert.match(prompt, /```tool_call/);
    assert.match(prompt, /read_file/);
    assert.match(prompt, /\/workspace/);
  });
});
