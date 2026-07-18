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

  it("renders an args signature generated from the tool's schema", () => {
    const prompt = buildToolsSystemPrompt([readFileTool], "/workspace");
    assert.ok(prompt);
    assert.match(prompt, /- read_file: read a text file in the workspace\./);
    assert.match(prompt, /\n {2}args: \{"path": <string, required — absolute path>\}/);
  });

  it("falls back to the plain description for a schema-less tool", () => {
    const prompt = buildToolsSystemPrompt(
      [
        {
          name: "legacy_tool",
          description: 'legacy_tool: {"x": 1} - does legacy things.',
          mutating: false,
          kind: "other",
          async execute() {
            return { output: "" };
          },
        },
      ],
      "/workspace",
    );
    assert.ok(prompt);
    assert.match(prompt, /- legacy_tool: \{"x": 1\} - does legacy things\./);
    assert.doesNotMatch(prompt, /args: undefined/);
  });
});
