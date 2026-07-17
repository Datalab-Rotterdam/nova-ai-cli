import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractToolCall, hasMalformedToolCall, hasPendingFence } from "../../../src/acp/tools/marker.js";

describe("hasPendingFence", () => {
  it("is false for plain text", () => {
    assert.equal(hasPendingFence("just some text"), false);
  });

  it("is true once the full fence marker appears", () => {
    assert.equal(hasPendingFence("here ```tool_call\n{}"), true);
  });

  it("is true while only a prefix of the fence marker has arrived", () => {
    assert.equal(hasPendingFence("here ``"), true);
    assert.equal(hasPendingFence("here ```tool"), true);
  });

  it("holds a split sentinel marker before it can leak into assistant text", () => {
    assert.equal(hasPendingFence("before <|tool_"), true);
    assert.equal(hasPendingFence("before <|tool_call>call:read_file:"), true);
  });

  it("is false when the tail doesn't match any fence prefix", () => {
    assert.equal(hasPendingFence("here ```python"), false);
  });
});

describe("extractToolCall", () => {
  it("returns null when no fence is present", () => {
    assert.equal(extractToolCall("just some text"), null);
  });

  it("returns null when the fence is unterminated", () => {
    assert.equal(extractToolCall('```tool_call\n{"name":"read_file"}'), null);
  });

  it("parses a complete fenced tool call", () => {
    const buffer = 'before\n```tool_call\n{"name":"read_file","args":{"path":"/tmp/x"}}\n```\nafter';
    const result = extractToolCall(buffer);
    assert.ok(result);
    assert.equal(result.name, "read_file");
    assert.deepEqual(result.args, { path: "/tmp/x" });
  });

  it("returns null for invalid JSON inside the fence", () => {
    assert.equal(extractToolCall("```tool_call\nnot json\n```"), null);
  });

  it("returns null when the JSON has no 'name' field", () => {
    assert.equal(extractToolCall('```tool_call\n{"args":{}}\n```'), null);
  });

  it("falls back to using the whole payload as args when 'args' is absent", () => {
    const result = extractToolCall('```tool_call\n{"name":"read_file","path":"/tmp/x"}\n```');
    assert.ok(result);
    assert.deepEqual(result.args, { name: "read_file", path: "/tmp/x" });
  });

  it("doesn't truncate on a literal ``` embedded inside the JSON payload's content", () => {
    const rawContent = "# Title\n```js\nconsole.log('hi')\n```\nmore text";
    const buffer = `\`\`\`tool_call\n{"name":"write_file","args":{"path":"/tmp/x.md","content":${JSON.stringify(rawContent)}}}\n\`\`\``;
    const result = extractToolCall(buffer);
    assert.ok(result);
    assert.equal(result.name, "write_file");
    assert.equal(result.args.content, rawContent);
  });

  it("parses sentinel calls with safe JavaScript-style object keys", () => {
    const buffer = '✦ <|tool_call>call:list_directory: {path: ".", options: {max_entries: 20}, include_hidden: false}<tool_call|>';
    const result = extractToolCall(buffer);
    assert.ok(result);
    assert.equal(result.name, "list_directory");
    assert.deepEqual(result.args, {
      path: ".",
      options: { max_entries: 20 },
      include_hidden: false,
    });
    assert.equal(buffer.slice(result.matchStart, result.matchEnd), '<|tool_call>call:list_directory: {path: ".", options: {max_entries: 20}, include_hidden: false}<tool_call|>');
  });

  it("recognizes a complete malformed sentinel call", () => {
    const buffer = '<|tool_call>call:list_directory: {path: }<tool_call|>';
    assert.equal(extractToolCall(buffer), null);
    assert.equal(hasMalformedToolCall(buffer), true);
  });
});
