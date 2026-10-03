import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RequestPermissionResponse } from "@agentclientprotocol/sdk";
import { HeadlessAcpClient, type HeadlessEvent } from "../../src/headless/client.js";

const NOVA_OPTIONS = [
  { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
  { optionId: "allow_session", name: "Allow for this session", kind: "allow_always" },
  { optionId: "allow_always", name: "Always allow", kind: "allow_always" },
  { optionId: "reject_once", name: "Reject", kind: "reject_once" },
];

test("headless answers what the agent's policy left without waiting: only bypass-all allows", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "nova-headless-client-"));
  try {
    for (const [mode, expected] of [
      ["read-only", "reject_once"],
      ["accept-edits", "reject_once"],
      ["bypass-all", "allow_once"],
    ] as const) {
      const client = new HeadlessAcpClient(cwd, mode, () => {});
      assert.equal(selectedOption(await permission(client, "run_command")), expected, mode);
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("headless reports decisions the agent made without asking", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "nova-headless-client-"));
  const events: HeadlessEvent[] = [];
  try {
    const client = new HeadlessAcpClient(cwd, "accept-edits", (event) => void events.push(event));
    const notify = (update: Record<string, unknown>) =>
      client.context().notify("session/update", { sessionId: "s", update });
    await notify({
      sessionUpdate: "tool_call",
      toolCallId: "c1",
      title: "Edit a.ts",
      kind: "edit",
      status: "pending",
      _meta: { "nova-ai-cli/tool": "edit_file" },
    });
    await notify({
      sessionUpdate: "tool_call_update",
      toolCallId: "c1",
      _meta: { "nova-ai-cli/permission": { decision: "allow", reason: "mode" } },
    });
    assert.deepEqual(
      events.filter((event) => event.type === "permission"),
      [{ type: "permission", toolCallId: "c1", toolName: "edit_file", decision: "allow", source: "accept-edits" }],
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

async function permission(
  client: HeadlessAcpClient,
  toolName: string,
): Promise<RequestPermissionResponse> {
  return (await client.context().request("session/request_permission", {
    sessionId: "session",
    toolCall: {
      toolCallId: `call-${toolName}`,
      title: toolName,
      kind: "execute",
      status: "pending",
      rawInput: {},
      _meta: { "nova-ai-cli/tool": toolName },
    },
    options: NOVA_OPTIONS,
  })) as RequestPermissionResponse;
}

function selectedOption(response: RequestPermissionResponse): string | null {
  return response.outcome.outcome === "selected" ? response.outcome.optionId : null;
}
