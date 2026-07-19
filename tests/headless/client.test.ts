import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RequestPermissionResponse } from "@agentclientprotocol/sdk";
import { HeadlessAcpClient } from "../../src/headless/client.js";

test("headless permission modes never wait for interactive approval", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "nova-headless-client-"));
  try {
    const readOnly = new HeadlessAcpClient(cwd, "read-only", () => {});
    const edit = await permission(readOnly, "write_file");
    assert.equal(selectedOption(edit), "reject");

    const acceptEdits = new HeadlessAcpClient(cwd, "accept-edits", () => {});
    assert.equal(
      selectedOption(await permission(acceptEdits, "write_file")),
      "allow",
    );
    assert.equal(
      selectedOption(await permission(acceptEdits, "run_command")),
      "reject",
    );

    const bypass = new HeadlessAcpClient(cwd, "bypass-all", () => {});
    assert.equal(
      selectedOption(await permission(bypass, "run_command")),
      "allow",
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
    },
    options: [],
  })) as RequestPermissionResponse;
}

function selectedOption(response: RequestPermissionResponse): string | null {
  return response.outcome.outcome === "selected"
    ? response.outcome.optionId
    : null;
}
