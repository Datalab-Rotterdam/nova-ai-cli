import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import {
  evaluatePermissionRules,
  exactPermissionRule,
} from "../../src/tui/settings/permission-rules.js";
import { writeWorkspaceSettings } from "../../src/tui/settings/workspace-settings.js";
import { TuiAcpClient } from "../../src/tui/session/tui-acp-client.js";
import { createStore } from "../../src/tui/state/store.js";
import type { UIState } from "../../src/tui/state/types.js";

test("Claude-style Bash allow rules match command arguments instead of the whole tool", () => {
  const permissions = {
    allow: ["Bash(npx tsc *)", "Bash(npm run *)", "Bash(gh api *)"],
  };

  assert.equal(
    evaluatePermissionRules(permissions, "run_command", {
      command: "npx tsc -p tsconfig.json",
    }),
    "allow",
  );
  assert.equal(
    evaluatePermissionRules(permissions, "run_command", {
      command: "npm run build",
    }),
    "allow",
  );
  assert.equal(
    evaluatePermissionRules(permissions, "run_command", {
      command: "gh api repos/example",
    }),
    "allow",
  );
  assert.equal(
    evaluatePermissionRules(permissions, "run_command", {
      command: "npm publish",
    }),
    "ask",
  );
});

test("quoted grep patterns from project settings match literally", () => {
  const command =
    'xargs grep -l "key\\\\.shift\\\\|\\\\.shift.*return\\\\|return.*shift"';
  assert.equal(
    evaluatePermissionRules({ allow: [`Bash(${command})`] }, "run_command", {
      command,
    }),
    "allow",
  );
});

test("deny rules take precedence over allow rules", () => {
  const permissions = {
    allow: ["Bash(npm run *)"],
    deny: ["Bash(npm run release *)"],
  };

  assert.equal(
    evaluatePermissionRules(permissions, "run_command", {
      command: "npm run release -- --latest",
    }),
    "deny",
  );
  assert.equal(
    evaluatePermissionRules(permissions, "run_command", {
      command: "npm run check",
    }),
    "allow",
  );
});

test("path aliases normalize Windows separators and exact rules escape shell wildcards", () => {
  assert.equal(
    evaluatePermissionRules({ allow: ["Edit(src/**)"] }, "edit_file", {
      path: "src\\tui\\app.ts",
    }),
    "allow",
  );
  const exact = exactPermissionRule("run_command", { command: "grep *.ts" });
  assert.equal(exact, "Bash(grep \\*.ts)");
  assert.equal(
    evaluatePermissionRules({ allow: [exact] }, "run_command", {
      command: "grep *.ts",
    }),
    "allow",
  );
  assert.equal(
    evaluatePermissionRules({ allow: [exact] }, "run_command", {
      command: "grep app.ts",
    }),
    "ask",
  );

  const exactPath = exactPermissionRule("edit_file", { path: "src\\*.ts" });
  assert.equal(exactPath, "Edit(src/[*].ts)");
  assert.equal(
    evaluatePermissionRules({ allow: [exactPath] }, "edit_file", {
      path: "src\\*.ts",
    }),
    "allow",
  );
  assert.equal(
    evaluatePermissionRules({ allow: [exactPath] }, "edit_file", {
      path: "src\\app.ts",
    }),
    "ask",
  );
});

test("TUI permission requests enforce deny before bypass mode", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "nova-permission-deny-"));
  try {
    writeWorkspaceSettings(cwd, {
      permissions: { deny: ["Bash(npm publish*)"] },
    });
    const store = createStore(state("bypassAll", cwd));
    const client = new TuiAcpClient(store, cwd);
    const response = await client.requestPermission(
      permissionRequest("npm publish"),
    );

    assert.deepEqual(response.outcome, {
      outcome: "selected",
      optionId: "reject",
    });
    assert.equal(store.getState().pendingPermission, null);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("always allow persists an exact argument-aware permission rule", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "nova-permission-always-"));
  try {
    writeWorkspaceSettings(cwd, {
      permissionMode: "ask",
      permissions: { allow: [] },
    });
    const store = createStore(state("ask", cwd));
    const client = new TuiAcpClient(store, cwd);
    const pending = client.requestPermission(permissionRequest("npm test"));
    store.getState().pendingPermission?.resolve(true, "always");
    await pending;

    const persisted = JSON.parse(
      readFileSync(join(cwd, ".nova-ai", "settings.json"), "utf8"),
    ) as {
      permissions?: { allow?: string[] };
    };
    assert.deepEqual(persisted.permissions?.allow, ["Bash(npm test)"]);

    const nextClient = new TuiAcpClient(createStore(state("ask", cwd)), cwd);
    const response = await nextClient.requestPermission(
      permissionRequest("npm test"),
    );
    assert.deepEqual(response.outcome, {
      outcome: "selected",
      optionId: "allow",
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

function permissionRequest(command: string): RequestPermissionRequest {
  return {
    sessionId: "test-session",
    toolCall: {
      toolCallId: "call-1",
      title: "run_command",
      kind: "execute",
      status: "pending",
      rawInput: { command },
    },
    options: [],
  };
}

function state(
  permissionMode: UIState["permissionMode"],
  cwd: string,
): UIState {
  return {
    messages: [],
    pendingPermission: null,
    pendingQuestion: null,
    inputHistory: [],
    busy: false,
    mode: "chat",
    permissionMode,
    interactionMode: "agent",
    sessionId: "test-session",
    cwd,
    statusLine: null,
    queuedCount: 0,
    contextUsage: null,
    updateAvailable: null,
  };
}
