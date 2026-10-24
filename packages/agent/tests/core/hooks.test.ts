import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { authorizeToolCall } from "../../src/acp/permission-flow.js";
import { loadHooks, matchingCommands, parseDecision, runHooks } from "../../src/core/hooks.js";
import { setWorkspaceTrusted } from "../../src/core/nova-home.js";
import { PermissionPolicy } from "../../src/core/policy/policy.js";
import { fetchUrlTool } from "../../src/core/tools/fetch-url.js";

/** A hook command that works under sh and cmd: node with a script free of $ and double quotes. */
export const nodeHook = (script: string) => `"${process.execPath}" -e "${script}"`;

describe("hook matching", () => {
  const config = {
    PreToolUse: [
      { matcher: "Bash", hooks: [{ type: "command", command: "bash-hook" }] },
      { matcher: "Edit|Write", hooks: [{ command: "edit-hook", timeout: 5 }] },
      { matcher: "mcp__github__.*", hooks: [{ command: "mcp-hook" }] },
      { matcher: "*", hooks: [{ command: "all-hook" }, { type: "prompt", command: "ignored" }] },
    ],
  };
  const names = (tool: string) => matchingCommands(config, "PreToolUse", tool).map((hook) => hook.command);

  it("matches Nova's names, Claude Code's names and regular expressions over the whole name", () => {
    assert.deepEqual(names("run_command"), ["bash-hook", "all-hook"]);
    assert.deepEqual(names("write_file"), ["edit-hook", "all-hook"]);
    assert.deepEqual(names("mcp__github__create_issue"), ["mcp-hook", "all-hook"]);
    assert.deepEqual(names("read_file"), ["all-hook"]);
    assert.equal(matchingCommands(config, "PreToolUse", "edit_file")[0]?.timeout, 5);
    assert.equal(matchingCommands(config, "PreToolUse", "read_file")[0]?.timeout, 60);
  });

  it("reads JSON decisions", () => {
    assert.deepEqual(parseDecision('{"decision":"block","reason":"no"}'), { block: "no", allow: false, context: undefined });
    assert.equal(parseDecision('{"hookSpecificOutput":{"permissionDecision":"allow"}}')?.allow, true);
    assert.equal(parseDecision('{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"r"}}')?.block, "r");
    assert.equal(parseDecision('{"continue":false,"stopReason":"halt"}')?.block, "halt");
    assert.equal(parseDecision('{"hookSpecificOutput":{"additionalContext":"ctx"}}')?.context, "ctx");
    assert.equal(parseDecision("plain text"), undefined);
  });
});

describe("running hooks", () => {
  it("passes the event on stdin, blocks on exit 2, warns on other failures and trusts workspace hooks only when trusted", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "nova-hooks-"));
    try {
      mkdirSync(join(cwd, ".nova-ai"));
      writeFileSync(
        join(cwd, ".nova-ai", "settings.json"),
        JSON.stringify({
          hooks: {
            UserPromptSubmit: [
              {
                hooks: [
                  { command: nodeHook("const e = JSON.parse(require('fs').readFileSync(0, 'utf8')); process.stdout.write(e.hook_event_name + ':' + e.prompt + ':' + e.session_id)") },
                  { command: nodeHook("process.exit(3)") },
                ],
              },
            ],
            PreToolUse: [{ matcher: "WebFetch", hooks: [{ command: nodeHook("process.stderr.write('not that site'); process.exit(2)") }] }],
          },
        }),
      );
      const options = { cwd, sessionId: "s1" };
      assert.deepEqual(loadHooks(cwd), {}, "an untrusted workspace's hooks never run");
      setWorkspaceTrusted(cwd, true);

      const prompt = await runHooks("UserPromptSubmit", { prompt: "hi" }, options);
      assert.equal(prompt.context, "UserPromptSubmit:hi:s1");
      assert.match(prompt.warnings[0] ?? "", /failed \(exit code 3\)/);
      assert.equal(prompt.block, undefined);

      const tool = await runHooks("PreToolUse", { tool_name: "fetch_url", tool_input: { url: "https://x" } }, options);
      assert.equal(tool.block, "not that site");
      assert.equal(tool.allow, false);
      assert.deepEqual(await runHooks("PreToolUse", { tool_name: "read_file", tool_input: {} }, options), { warnings: [] });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("stops a hook at its timeout", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "nova-hooks-timeout-"));
    try {
      setWorkspaceTrusted(cwd, true);
      mkdirSync(join(cwd, ".nova-ai"));
      writeFileSync(
        join(cwd, ".nova-ai", "settings.json"),
        JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: nodeHook("setTimeout(() => {}, 60000)"), timeout: 0.3 }] }] } }),
      );
      const started = Date.now();
      const outcome = await runHooks("Stop", {}, { cwd, sessionId: "s1" });
      assert.match(outcome.warnings[0] ?? "", /timed out after 0.3s/);
      assert.ok(Date.now() - started < 5_000);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("a PreToolUse allow skips the question, but a deny rule still wins", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "nova-hooks-allow-"));
    try {
      let asked = 0;
      const options = {
        client: { request: async () => (asked++, { outcome: { outcome: "cancelled" } }), notify: async () => {} } as never,
        sessionId: "s1",
        cwd,
        host: {} as never,
        policy: new PermissionPolicy(cwd, "default"),
        signal: new AbortController().signal,
      };
      const args = { url: "https://example.com" };
      assert.deepEqual(await authorizeToolCall(options, "t1", fetchUrlTool, args, true), { allowed: true });
      assert.equal(asked, 0);
      mkdirSync(join(cwd, ".nova-ai"));
      writeFileSync(join(cwd, ".nova-ai", "settings.json"), JSON.stringify({ permissions: { deny: ["fetch_url"] } }));
      options.policy = new PermissionPolicy(cwd, "default");
      assert.deepEqual(await authorizeToolCall(options, "t2", fetchUrlTool, args, true), { allowed: false, reason: "rule" });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
