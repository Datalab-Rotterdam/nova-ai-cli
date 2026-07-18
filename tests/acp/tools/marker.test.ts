import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  extractToolCall,
  hasIncompleteToolCall,
  hasMalformedToolCall,
  hasPendingFence,
  scanToolCalls,
  stripToolCallMarkup,
  tailMayContinueToolCalls,
} from "../../../src/acp/tools/marker.js";

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
    const buffer =
      'before\n```tool_call\n{"name":"read_file","args":{"path":"/tmp/x"}}\n```\nafter';
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
    const result = extractToolCall(
      '```tool_call\n{"name":"read_file","path":"/tmp/x"}\n```',
    );
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
    const buffer =
      '✦ <|tool_call>call:list_directory: {path: ".", options: {max_entries: 20}, include_hidden: false}<tool_call|>';
    const result = extractToolCall(buffer);
    assert.ok(result);
    assert.equal(result.name, "list_directory");
    assert.deepEqual(result.args, {
      path: ".",
      options: { max_entries: 20 },
      include_hidden: false,
    });
    assert.equal(
      buffer.slice(result.matchStart, result.matchEnd),
      '<|tool_call>call:list_directory: {path: ".", options: {max_entries: 20}, include_hidden: false}<tool_call|>',
    );
  });

  it("recognizes a complete malformed sentinel call", () => {
    const buffer = "<|tool_call>call:list_directory: {path: }<tool_call|>";
    assert.equal(extractToolCall(buffer), null);
    assert.equal(hasMalformedToolCall(buffer), true);
  });
});

describe("incomplete tool call markup", () => {
  it("recognizes a started fence that has no closing marker", () => {
    const partial =
      'Visible preamble.\n```tool_call\n{"name":"write_file","args":{"content":"unfinished';
    assert.equal(hasIncompleteToolCall(partial), true);
    assert.equal(stripToolCallMarkup(partial), "Visible preamble.\n");
  });

  it("does not treat ordinary trailing backticks as an incomplete tool call", () => {
    assert.equal(hasIncompleteToolCall("Use `npm test`"), false);
    assert.equal(stripToolCallMarkup("Use `npm test`"), "Use `npm test`");
  });
});

describe("scanToolCalls", () => {
  it("returns consecutive fenced blocks in order with correct offsets", () => {
    const first = '```tool_call\n{"name":"read_file","args":{"path":"a.ts"}}\n```';
    const second = '```tool_call\n{"name":"read_file","args":{"path":"b.ts"}}\n```';
    const buffer = `${first}\n${second}`;
    const scan = scanToolCalls(buffer);
    assert.equal(scan.blocks.length, 2);
    assert.equal(scan.blocks[0]?.kind, "call");
    assert.equal(scan.blocks[1]?.kind, "call");
    if (scan.blocks[0]?.kind === "call" && scan.blocks[1]?.kind === "call") {
      assert.deepEqual(scan.blocks[0].call.args, { path: "a.ts" });
      assert.deepEqual(scan.blocks[1].call.args, { path: "b.ts" });
    }
    assert.equal(scan.blocks[0]?.matchStart, 0);
    assert.equal(scan.blocks[0]?.matchEnd, first.length);
    assert.equal(scan.lastMatchEnd, buffer.length);
  });

  it("does not let a ``` inside one payload swallow the next block", () => {
    const first =
      '```tool_call\n{"name":"write_file","args":{"path":"doc.md","content":"example:\\n```js\\ncode\\n```\\ndone"}}\n```';
    const second = '```tool_call\n{"name":"read_file","args":{"path":"b.ts"}}\n```';
    const scan = scanToolCalls(`${first}\n${second}`);
    assert.equal(scan.blocks.length, 2);
    assert.equal(scan.blocks[0]?.kind, "call");
    if (scan.blocks[0]?.kind === "call") {
      assert.match(String(scan.blocks[0].call.args.content), /```js/);
    }
    assert.equal(scan.blocks[1]?.kind, "call");
  });

  it("marks an unparseable block malformed while keeping valid neighbours", () => {
    const buffer =
      '```tool_call\n{"name":"read_file","args":{"path":"a.ts"}}\n```\n' +
      "```tool_call\n{broken json\n```\n" +
      '```tool_call\n{"name":"read_file","args":{"path":"c.ts"}}\n```';
    const scan = scanToolCalls(buffer);
    assert.deepEqual(
      scan.blocks.map((block) => block.kind),
      ["call", "malformed", "call"],
    );
  });

  it("stops before a trailing incomplete block", () => {
    const complete = '```tool_call\n{"name":"read_file","args":{"path":"a.ts"}}\n```';
    const scan = scanToolCalls(complete + '\n```tool_call\n{"name":"rea');
    assert.equal(scan.blocks.length, 1);
    assert.equal(scan.lastMatchEnd, complete.length);
  });

  it("scans mixed sentinel and fenced blocks", () => {
    const buffer =
      '<|tool_call>call:list_directory: {path: "."}<tool_call|>\n' +
      '```tool_call\n{"name":"read_file","args":{"path":"a.ts"}}\n```';
    const scan = scanToolCalls(buffer);
    assert.equal(scan.blocks.length, 2);
    assert.equal(scan.blocks[0]?.kind, "call");
    if (scan.blocks[0]?.kind === "call") {
      assert.equal(scan.blocks[0].call.name, "list_directory");
    }
  });
});

describe("tailMayContinueToolCalls", () => {
  it("continues on whitespace and marker prefixes", () => {
    assert.equal(tailMayContinueToolCalls(""), true);
    assert.equal(tailMayContinueToolCalls("\n\n  "), true);
    assert.equal(tailMayContinueToolCalls("\n``"), true);
    assert.equal(tailMayContinueToolCalls("\n```tool_call\n{"), true);
    assert.equal(tailMayContinueToolCalls("\n<|tool_"), true);
  });

  it("cuts on ordinary prose", () => {
    assert.equal(tailMayContinueToolCalls("The result shows..."), false);
    assert.equal(tailMayContinueToolCalls("\nDone."), false);
  });
});
