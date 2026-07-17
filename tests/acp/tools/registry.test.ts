import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { availableTools, findTool } from "../../../src/acp/tools/registry.js";
import { FULL_CAPABILITIES, makeEnvironment } from "./test-helpers.js";

describe("availableTools", () => {
  it("returns no tools when no capabilities are present", () => {
    assert.deepEqual(availableTools(undefined), []);
  });

  it("includes read_file only when fs.readTextFile is supported", () => {
    const caps = { fs: { readTextFile: true } };
    const names = availableTools(
      caps,
      makeEnvironment({
        clientCapabilities: caps,
        packageManager: null,
        packageScripts: [],
      }),
    ).map((t) => t.name);
    assert.deepEqual(names.sort(), [
      "inspect_environment",
      "list_directory",
      "read_file",
      "search_text",
    ]);
  });

  it("includes write_file only when fs.writeTextFile is supported", () => {
    const names = availableTools({ fs: { writeTextFile: true } }).map(
      (t) => t.name,
    );
    assert.deepEqual(names, ["write_file"]);
  });

  it("includes edit_file only when fs read+write are supported", () => {
    const names = availableTools({
      fs: { readTextFile: true, writeTextFile: true },
    }).map((t) => t.name);
    assert.deepEqual(names.sort(), ["edit_file", "read_file", "write_file"]);
  });

  it("includes run_command only when terminal is supported", () => {
    const names = availableTools({ terminal: true }).map((t) => t.name);
    assert.deepEqual(names, ["run_command"]);
  });

  it("includes all tools when all capabilities are present", () => {
    const names = availableTools(FULL_CAPABILITIES, makeEnvironment()).map(
      (t) => t.name,
    );
    assert.deepEqual(names.sort(), [
      "ask_user",
      "edit_file",
      "inspect_environment",
      "list_directory",
      "read_file",
      "run_command",
      "run_package_script",
      "search_text",
      "write_file",
    ]);
  });

  it("includes background tools only when a background service is available", () => {
    const withoutBackground = availableTools(
      FULL_CAPABILITIES,
      makeEnvironment(),
    ).map((t) => t.name);
    const withBackground = availableTools(
      FULL_CAPABILITIES,
      makeEnvironment(),
      { background: true },
    ).map((t) => t.name);

    assert.equal(withoutBackground.includes("start_background_command"), false);
    assert.equal(withBackground.includes("start_background_command"), true);
    assert.equal(withBackground.includes("start_background_agent"), true);
    assert.equal(withBackground.includes("list_background_jobs"), true);
    assert.equal(withBackground.includes("read_background_output"), true);
    assert.equal(withBackground.includes("kill_background_job"), true);
    assert.equal(withBackground.includes("release_background_job"), true);
  });

  it("does not include package scripts without terminal support", () => {
    const caps = { fs: { readTextFile: true, writeTextFile: true } };
    const names = availableTools(
      caps,
      makeEnvironment({ clientCapabilities: caps }),
    ).map((t) => t.name);
    assert.equal(names.includes("run_package_script"), false);
  });

  it("does not include package scripts without package manager or scripts", () => {
    const names = availableTools(
      FULL_CAPABILITIES,
      makeEnvironment({ packageManager: null, packageScripts: [] }),
    ).map((t) => t.name);
    assert.equal(names.includes("run_package_script"), false);
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
