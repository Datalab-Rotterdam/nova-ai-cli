import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ensureProject, isWorkspaceTrusted, projectPaths, setWorkspaceTrusted } from "../../src/core/nova-home.js";
import { PermissionPolicy } from "../../src/core/policy/policy.js";
import { evaluatePermissionRules } from "../../src/core/policy/rules.js";
import { loadPermissionRules, savedPermissionMode } from "../../src/core/policy/settings.js";

let base: string;
let cwd: string;
const previousHome = process.env.NOVA_AI_HOME;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "nova-policy-"));
  cwd = join(base, "repo");
  mkdirSync(join(cwd, ".nova-ai"), { recursive: true });
  process.env.NOVA_AI_HOME = join(base, "home");
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.NOVA_AI_HOME;
  else process.env.NOVA_AI_HOME = previousHome;
});

const write = (path: string, value: unknown) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
};
const run = { name: "run_command", mutating: true, kind: "execute" as const };
const edit = { name: "edit_file", mutating: true, kind: "edit" as const };
const read = { name: "read_file", mutating: false, kind: "read" as const };
const memory = { name: "memory_write", mutating: true, kind: "edit" as const };

describe("permission rule sources", () => {
  it("ignores allow rules from the repository until the workspace is trusted", () => {
    write(join(cwd, ".nova-ai", "settings.json"), {
      permissions: { allow: ["Bash(*)"], deny: ["Bash(rm *)"] },
    });
    write(join(cwd, ".nova-ai", "settings.local.json"), { permissions: { allow: ["edit_file"] } });
    assert.deepEqual(loadPermissionRules(cwd), { allow: [], deny: ["Bash(rm *)"] });

    setWorkspaceTrusted(cwd, true);
    assert.ok(isWorkspaceTrusted(cwd));
    assert.deepEqual(loadPermissionRules(cwd), { allow: ["Bash(*)", "edit_file"], deny: ["Bash(rm *)"] });
  });

  it("always applies the user's own global and private project rules", () => {
    write(join(base, "home", "settings.json"), { permissions: { allow: ["Bash(npm test)"] } });
    write(projectPaths(cwd).settings, { permissions: { allow: ["Bash(npm run lint)"] } });
    assert.deepEqual(loadPermissionRules(cwd).allow, ["Bash(npm test)", "Bash(npm run lint)"]);
  });

  it("keeps project.json fields when trust changes (shared with the extension)", () => {
    const paths = ensureProject(cwd);
    write(paths.info, { ...JSON.parse(readFileSync(paths.info, "utf8")), extensionField: 1 });
    setWorkspaceTrusted(cwd, true);
    const info = JSON.parse(readFileSync(paths.info, "utf8"));
    assert.equal(info.extensionField, 1);
    assert.equal(info.trusted, true);
  });
});

describe("PermissionPolicy", () => {
  it("lets deny rules block even read-only tools and bypass mode", () => {
    write(join(base, "home", "settings.json"), {
      permissions: { deny: ["Read(.env)", "Bash(rm *)"] },
    });
    const policy = new PermissionPolicy(cwd, "bypassPermissions");
    assert.deepEqual(policy.decide(read, { path: join(cwd, ".env") }), { decision: "deny", reason: "deny-rule" });
    assert.deepEqual(policy.decide(read, { path: "src/a.ts" }), { decision: "allow", reason: "read-only" });
    assert.equal(policy.decide(run, { command: "ls && rm -rf /" }).decision, "deny");
  });

  it("asks by default, auto-accepts edits only in acceptEdits mode, and never memory", () => {
    const policy = new PermissionPolicy(cwd, "default");
    assert.deepEqual(policy.decide(edit, { path: "a.ts" }), { decision: "ask" });
    policy.setMode("acceptEdits", false);
    assert.deepEqual(policy.decide(edit, { path: "a.ts" }), { decision: "allow", reason: "mode" });
    assert.deepEqual(policy.decide(run, { command: "ls" }), { decision: "ask" });
    policy.setMode("bypassPermissions", false);
    assert.deepEqual(policy.decide(run, { command: "ls" }), { decision: "allow", reason: "mode" });
    assert.deepEqual(policy.decide(memory, { action: "remember" }), { decision: "ask" });
  });

  it("remembers session approvals exactly, and always-allow in private settings", () => {
    const policy = new PermissionPolicy(cwd, "default");
    policy.allowForSession(run, { command: "npm test" });
    assert.equal(policy.decide(run, { command: "npm test" }).decision, "allow");
    assert.equal(policy.decide(run, { command: "npm test && curl evil" }).decision, "ask");

    const rule = policy.allowAlways(edit, { path: join(cwd, "src", "a.ts") });
    assert.equal(rule, "edit_file(src/a.ts)");
    const fresh = new PermissionPolicy(cwd, "default");
    assert.deepEqual(fresh.decide(edit, { path: "src/a.ts" }), { decision: "allow", reason: "allow-rule" });
    assert.ok(!readFileSync(projectPaths(cwd).settings, "utf8").includes("bypass"));
    assert.throws(() => readFileSync(join(cwd, ".nova-ai", "settings.local.json")));
  });

  it("never restores bypass mode or a mode chosen by the repository", () => {
    write(join(cwd, ".nova-ai", "settings.json"), { permissionMode: "bypassAll" });
    assert.equal(savedPermissionMode(cwd), "default");
    const policy = new PermissionPolicy(cwd);
    policy.setMode("bypassPermissions");
    assert.equal(savedPermissionMode(cwd), "default");
    policy.setMode("acceptEdits");
    assert.equal(new PermissionPolicy(cwd).mode, "acceptEdits");
  });
});

describe("path subjects", () => {
  it("match workspace-relative rules for absolute and relative paths", () => {
    const rules = { allow: ["edit_file(src/*)"] };
    assert.equal(evaluatePermissionRules(rules, "edit_file", { path: "src/a.ts" }, cwd), "allow");
    assert.equal(evaluatePermissionRules(rules, "edit_file", { path: join(cwd, "src", "a.ts") }, cwd), "allow");
    assert.equal(evaluatePermissionRules(rules, "edit_file", { path: "../src/a.ts" }, cwd), "ask");
  });
});

describe("tool names shared with nova-ai-vscode", () => {
  it("gives create_file, list_dir and fetch_url their subjects", () => {
    assert.equal(evaluatePermissionRules({ allow: ["Write(src/*)"] }, "create_file", { path: "src/a.ts" }, cwd), "allow");
    assert.equal(evaluatePermissionRules({ deny: ["list_dir(secrets)"] }, "list_dir", { path: "secrets" }, cwd), "deny");
    assert.equal(
      evaluatePermissionRules({ allow: ["fetch_url(https://docs.example.com/*)"] }, "fetch_url", { url: "https://docs.example.com/a" }, cwd),
      "allow",
    );
    assert.equal(
      evaluatePermissionRules({ allow: ["fetch_url(https://docs.example.com/*)"] }, "fetch_url", { url: "https://evil.example/a" }, cwd),
      "ask",
    );
  });
});
