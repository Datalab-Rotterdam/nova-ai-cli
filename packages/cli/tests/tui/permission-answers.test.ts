import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type * as acp from "@agentclientprotocol/sdk";
import { choosePermissionOption } from "../../src/tui/session/tui-acp-client.js";

describe("TUI answer mapping", () => {
  const nova = [
    { optionId: "allow_once", name: "", kind: "allow_once" },
    { optionId: "allow_session", name: "", kind: "allow_always" },
    { optionId: "allow_always", name: "", kind: "allow_always" },
    { optionId: "reject_once", name: "", kind: "reject_once" },
  ] as acp.PermissionOption[];
  it("maps once/session/always/deny to Nova's options", () => {
    assert.equal(choosePermissionOption(nova, true, "once"), "allow_once");
    assert.equal(choosePermissionOption(nova, true, "session"), "allow_session");
    assert.equal(choosePermissionOption(nova, true, "always"), "allow_always");
    assert.equal(choosePermissionOption(nova, false, "once"), "reject_once");
  });
  it("falls back to option kinds for other agents and never invents consent", () => {
    const other = [
      { optionId: "yes", name: "", kind: "allow_once" },
      { optionId: "no", name: "", kind: "reject_once" },
    ] as acp.PermissionOption[];
    assert.equal(choosePermissionOption(other, true, "once"), "yes");
    assert.equal(choosePermissionOption(other, false, "once"), "no");
    assert.equal(choosePermissionOption([], true, "always"), null);
  });
});
