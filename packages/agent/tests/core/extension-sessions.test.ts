import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  extensionSessionToTurns,
  importExtensionSessions,
  type ExtensionStoredSession,
} from "../../src/core/extension-sessions.js";
import { projectPaths } from "../../src/core/nova-home.js";
import {
  deleteStoredSession,
  listSessionCheckpoints,
  listStoredSessions,
  loadStoredSession,
} from "../../src/core/sessions.js";

const ID = "6f1c2b9e-4d3a-4c5b-9e8f-0a1b2c3d4e5f";
const OTHER_ID = "0b7e5c1a-2f3d-4e6a-8b9c-1d2e3f4a5b6c";
const UPDATED = Date.UTC(2026, 9, 3, 12, 0, 0);

/** A chat as the panel stores it: a prompt, a tool round with steering, an answer, a follow-up. */
function panelChat(id = ID): ExtensionStoredSession {
  return {
    id,
    title: "Fix the build",
    createdAt: UPDATED - 60_000,
    updatedAt: UPDATED,
    messages: [
      { role: "user", parts: [{ type: "text", value: "Why does the build fail?" }] },
      {
        role: "assistant",
        parts: [
          { type: "text", value: "Let me look." },
          { type: "toolCall", callId: "c1", name: "list_dir", input: { path: "." } },
          { type: "toolCall", callId: "c2", name: "read_file", input: { path: "package.json" } },
        ],
      },
      { role: "user", parts: [{ type: "toolResult", callId: "c1", text: "src/\npackage.json" }] },
      { role: "user", parts: [{ type: "text", value: "Also check tsconfig." }] },
      { role: "assistant", parts: [{ type: "text", value: "The script name is wrong." }] },
      { role: "user", parts: [{ type: "text", value: "Fix it." }] },
      {
        role: "assistant",
        parts: [{ type: "toolCall", callId: "c3", name: "create_file", input: { path: "a.txt", content: "x" } }],
      },
      { role: "user", parts: [{ type: "toolResult", callId: "c3", text: "Created a.txt" }] },
      { role: "assistant", parts: [{ type: "text", value: "Done." }] },
    ],
  };
}

describe("extensionSessionToTurns", () => {
  it("rebuilds native tool messages, answers every call and splits turns at the user's prompts", () => {
    const turns = extensionSessionToTurns(panelChat());
    assert.equal(turns.length, 2);
    assert.ok(turns.every((turn) => turn.updatedAt === "2026-10-03T12:00:00.000Z"));
    assert.deepEqual(turns[0]!.messages, [
      { role: "user", content: "Why does the build fail?" },
      {
        role: "assistant",
        content: "Let me look.",
        tool_calls: [
          { id: "c1", type: "function", function: { name: "list_directory", arguments: '{"path":"."}' } },
          { id: "c2", type: "function", function: { name: "read_file", arguments: '{"path":"package.json"}' } },
        ],
      },
      { role: "tool", tool_call_id: "c1", content: "src/\npackage.json" },
      // c2 had no stored result: answered, so the history stays valid for the model.
      { role: "tool", tool_call_id: "c2", content: "Tool error: Cancelled before this call completed." },
      // Steering during tool work stays in the running turn.
      { role: "user", content: "Also check tsconfig." },
      { role: "assistant", content: "The script name is wrong." },
    ]);
    assert.equal(turns[1]!.messages[0]!.content, "Fix it.");
    assert.equal(
      (turns[1]!.messages[1] as unknown as { tool_calls: Array<{ function: { name: string } }> }).tool_calls[0]!.function.name,
      "write_file",
    );
  });

  it("drops a tool result whose call was compacted away", () => {
    const turns = extensionSessionToTurns({
      ...panelChat(),
      messages: [
        { role: "user", parts: [{ type: "text", value: "<conversation-summary>…</conversation-summary>" }] },
        { role: "user", parts: [{ type: "toolResult", callId: "gone", text: "old" }, { type: "text", value: "Go on." }] },
        { role: "assistant", parts: [{ type: "text", value: "Continuing." }] },
      ],
    });
    assert.equal(turns.length, 1);
    assert.deepEqual(
      turns[0]!.messages.map((message) => message.role),
      ["user", "user", "assistant"],
    );
  });

  it("returns nothing for an empty or malformed chat", () => {
    assert.deepEqual(extensionSessionToTurns({ ...panelChat(), messages: [] }), []);
    assert.deepEqual(extensionSessionToTurns({ id: ID } as unknown as ExtensionStoredSession), []);
  });
});

describe("importExtensionSessions", () => {
  let cwd: string;
  let sourceDir: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "nova-import-ws-"));
    sourceDir = join(projectPaths(cwd).dir, "sessions");
    mkdirSync(sourceDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(projectPaths(cwd).dir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  const writePanelChats = (...chats: ExtensionStoredSession[]) => {
    writeFileSync(
      join(sourceDir, "index.json"),
      JSON.stringify(chats.map((chat) => ({ id: chat.id, title: chat.title, updatedAt: chat.updatedAt }))),
    );
    for (const chat of chats) writeFileSync(join(sourceDir, `${chat.id}.json`), JSON.stringify(chat));
  };

  it("imports each panel chat once, keeps its id, title and time, and leaves the panel's files alone", () => {
    writePanelChats(panelChat());
    const before = readFileSync(join(sourceDir, `${ID}.json`), "utf8");

    assert.equal(importExtensionSessions(cwd), 1);
    const session = loadStoredSession(ID)!;
    assert.equal(session.cwd, cwd);
    assert.equal(session.title, "Fix the build");
    assert.equal(session.updatedAt, "2026-10-03T12:00:00.000Z");
    assert.equal(session.messages.length, 10);
    assert.equal(listSessionCheckpoints(ID).length, 2, "one checkpoint per turn, so rewind works");
    assert.deepEqual(
      listStoredSessions(cwd).map((summary) => summary.sessionId),
      [ID],
    );
    assert.equal(readFileSync(join(sourceDir, `${ID}.json`), "utf8"), before);

    assert.equal(importExtensionSessions(cwd), 0, "a second run imports nothing");
    deleteStoredSession(ID);
    assert.equal(importExtensionSessions(cwd), 0, "a deleted import does not come back");
    assert.equal(loadStoredSession(ID), null);
  });

  it("picks up chats the panel saved after the first import", () => {
    writePanelChats(panelChat());
    importExtensionSessions(cwd);
    writePanelChats(panelChat(), { ...panelChat(OTHER_ID), title: "New chat" });
    assert.equal(importExtensionSessions(cwd), 1);
    assert.equal(loadStoredSession(OTHER_ID)?.title, "Why does the build fail?", "untitled chats get a derived title");
  });

  it("skips invalid ids and unreadable chats without failing", () => {
    writeFileSync(
      join(sourceDir, "index.json"),
      JSON.stringify([{ id: "../escape", title: "x", updatedAt: 1 }, { id: ID, title: "x", updatedAt: 1 }]),
    );
    writeFileSync(join(sourceDir, `${ID}.json`), "not json");
    assert.equal(importExtensionSessions(cwd), 0);
    assert.deepEqual(
      readdirSync(projectPaths(cwd).cliSessions).filter((file) => file.endsWith(".jsonl")),
      [],
    );
  });

  it("does nothing for a workspace the panel never used", () => {
    rmSync(sourceDir, { recursive: true, force: true });
    assert.equal(importExtensionSessions(cwd), 0);
    assert.equal(existsSync(projectPaths(cwd).cliSessions), false);
  });
});
