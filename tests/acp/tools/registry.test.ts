import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { availableTools, findTool } from "../../../src/acp/tools/registry.js";

describe("availableTools", () => {
  it("returns no tools when no capabilities are present", () => {
    assert.deepEqual(availableTools(undefined), []);
  });

  it("includes read_file only when fs.readTextFile is supported", () => {
    const names = availableTools({ fs: { readTextFile: true } }).map((t) => t.name);
    assert.deepEqual(names, ["read_file"]);
  });

  it("includes write_file only when fs.writeTextFile is supported", () => {
    const names = availableTools({ fs: { writeTextFile: true } }).map((t) => t.name);
    assert.deepEqual(names, ["write_file"]);
  });

  it("includes run_command only when terminal is supported", () => {
    const names = availableTools({ terminal: true }).map((t) => t.name);
    assert.deepEqual(names, ["run_command"]);
  });

  it("includes all tools when all capabilities are present", () => {
    const names = availableTools({
      fs: { readTextFile: true, writeTextFile: true },
      terminal: true,
    }).map((t) => t.name);
    assert.deepEqual(names.sort(), ["read_file", "run_command", "write_file"]);
  });
});

describe("findTool", () => {
  it("finds a registered tool by name", () => {
    assert.equal(findTool("read_file")?.name, "read_file");
  });

  it("returns undefined for an unknown tool name", () => {
    assert.equal(findTool("does_not_exist"), undefined);
  });
});
