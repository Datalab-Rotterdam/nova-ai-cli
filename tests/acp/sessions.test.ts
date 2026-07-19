import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it, test } from "node:test";
import {
  appendSessionTurn,
  deleteStoredSession,
  deriveTitle,
  forkStoredSession,
  listSessionCheckpoints,
  loadStoredSession,
  parseSessionFile,
  rewindStoredSession,
} from "../../src/acp/sessions.js";

const testSessionsDir = mkdtempSync(join(tmpdir(), "nova-sessions-test-"));
process.env.NOVA_AI_CLI_SESSIONS_DIR = testSessionsDir;
after(() => {
  delete process.env.NOVA_AI_CLI_SESSIONS_DIR;
  rmSync(testSessionsDir, { recursive: true, force: true });
});

describe("deriveTitle", () => {
  it("returns null when there is no user message", () => {
    assert.equal(deriveTitle([{ role: "assistant", content: "hi" }]), null);
  });

  it("returns null when the first user message is empty", () => {
    assert.equal(deriveTitle([{ role: "user", content: "   " }]), null);
  });

  it("uses text from multimodal user content", () => {
    assert.equal(
      deriveTitle([
        { role: "user", content: [{ type: "text", text: "hi" }] as any },
      ]),
      "hi",
    );
  });

  it("returns the trimmed first user message", () => {
    assert.equal(
      deriveTitle([{ role: "user", content: "  hello there  " }]),
      "hello there",
    );
  });

  it("normalizes a multiline prompt to a one-line title", () => {
    assert.equal(
      deriveTitle([
        { role: "user", content: "inspect the TUI\nthen fix\tits picker" },
      ]),
      "inspect the TUI then fix its picker",
    );
  });

  it("truncates long messages to 60 chars with an ellipsis", () => {
    const text = "x".repeat(80);
    const title = deriveTitle([{ role: "user", content: text }]);
    assert.equal(title, `${"x".repeat(60)}…`);
  });

  it("ignores leading assistant messages and uses the first user message", () => {
    assert.equal(
      deriveTitle([
        { role: "assistant", content: "ignored" },
        { role: "user", content: "actual title" },
      ]),
      "actual title",
    );
  });
});

test("a persisted compaction marker replaces earlier history and keeps later turns", () => {
  const raw = [
    JSON.stringify({ kind: "header", cwd: "/repo", title: "test" }),
    JSON.stringify({
      kind: "message",
      updatedAt: "2026-01-01T00:00:00Z",
      message: { role: "user", content: "old" },
    }),
    JSON.stringify({
      kind: "compaction",
      updatedAt: "2026-01-02T00:00:00Z",
      messages: [
        { role: "system", content: "summary" },
        { role: "user", content: "recent" },
      ],
    }),
    JSON.stringify({
      kind: "message",
      updatedAt: "2026-01-03T00:00:00Z",
      message: { role: "assistant", content: "later" },
    }),
  ].join("\n");

  const session = parseSessionFile(raw);
  assert.deepEqual(session?.messages, [
    { role: "system", content: "summary" },
    { role: "user", content: "recent" },
    { role: "assistant", content: "later" },
  ]);
  assert.equal(session?.updatedAt, "2026-01-03T00:00:00Z");
});

test("oversized persisted tool results are bounded when session history is restored", () => {
  const ordinaryUserMessage = `User supplied ${"u".repeat(110_000)}`;
  const toolResult = `Tool result: start:${"x".repeat(120_000)}:end`;
  const raw = [
    JSON.stringify({ kind: "header", cwd: "/repo", title: "test" }),
    JSON.stringify({
      kind: "message",
      updatedAt: "2026-01-01T00:00:00Z",
      message: { role: "user", content: ordinaryUserMessage },
    }),
    JSON.stringify({
      kind: "message",
      updatedAt: "2026-01-01T00:00:01Z",
      message: { role: "user", content: toolResult },
    }),
  ].join("\n");

  const session = parseSessionFile(raw);
  assert.equal(session?.messages[0]?.content, ordinaryUserMessage);
  const restoredToolResult = String(session?.messages[1]?.content);
  assert.ok(restoredToolResult.length <= 100_020);
  assert.match(restoredToolResult, /^Tool result: start:/);
  assert.match(restoredToolResult, /:end$/);
  assert.match(restoredToolResult, /Tool output truncated from 120010/);
});

describe("deleteStoredSession", () => {
  it("removes a persisted session file", () => {
    const sessionId = `test-delete-${crypto.randomUUID()}`;
    appendSessionTurn(sessionId, { cwd: "/repo", title: "t" }, [
      { role: "user", content: "hi" },
    ]);
    assert.ok(loadStoredSession(sessionId));
    deleteStoredSession(sessionId);
    assert.equal(loadStoredSession(sessionId), null);
  });

  it("does not throw when the session file is missing", () => {
    assert.doesNotThrow(() =>
      deleteStoredSession(`test-missing-${crypto.randomUUID()}`),
    );
  });
});

describe("forkStoredSession", () => {
  it("copies messages and title under a new id without touching the source", () => {
    const sourceId = `test-fork-source-${crypto.randomUUID()}`;
    const newId = `test-fork-new-${crypto.randomUUID()}`;
    appendSessionTurn(sourceId, { cwd: "/repo", title: "original" }, [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);

    const forked = forkStoredSession(sourceId, newId, { cwd: "/other" });
    assert.equal(forked?.sessionId, newId);
    assert.equal(forked?.cwd, "/other");
    assert.equal(forked?.title, "original");

    const reloadedFork = loadStoredSession(newId);
    assert.deepEqual(reloadedFork?.messages, [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);

    const reloadedSource = loadStoredSession(sourceId);
    assert.equal(reloadedSource?.cwd, "/repo");
    assert.equal(reloadedSource?.messages.length, 2);

    deleteStoredSession(sourceId);
    deleteStoredSession(newId);
  });

  it("returns null when the source session does not exist", () => {
    const result = forkStoredSession(
      `test-missing-${crypto.randomUUID()}`,
      `test-new-${crypto.randomUUID()}`,
      { cwd: "/repo" },
    );
    assert.equal(result, null);
  });
});

describe("rewindStoredSession", () => {
  it("rewinds complete turns and keeps the append-only session readable", () => {
    const sessionId = `test-rewind-${crypto.randomUUID()}`;
    try {
      appendSessionTurn(sessionId, { cwd: "/repo", title: "first" }, [
        { role: "user", content: "first request" },
        { role: "assistant", content: "first response" },
      ]);
      appendSessionTurn(sessionId, { cwd: "/repo", title: "first" }, [
        { role: "user", content: "second request" },
        { role: "assistant", content: "calling a tool" },
        { role: "user", content: "Tool result: done" },
        { role: "assistant", content: "second response" },
      ]);

      assert.deepEqual(
        listSessionCheckpoints(sessionId).map(
          (checkpoint) => checkpoint.userText,
        ),
        ["first request", "second request"],
      );
      const rewound = rewindStoredSession(sessionId);
      assert.deepEqual(
        rewound?.removedCheckpoints.map((item) => item.userText),
        ["second request"],
      );
      assert.deepEqual(loadStoredSession(sessionId)?.messages, [
        { role: "user", content: "first request" },
        { role: "assistant", content: "first response" },
      ]);
      assert.equal(listSessionCheckpoints(sessionId).length, 1);

      const rewoundAgain = rewindStoredSession(sessionId);
      assert.deepEqual(rewoundAgain?.session.messages, []);
      assert.deepEqual(listSessionCheckpoints(sessionId), []);
    } finally {
      deleteStoredSession(sessionId);
    }
  });

  it("rejects invalid or unavailable rewind distances", () => {
    const sessionId = `test-rewind-invalid-${crypto.randomUUID()}`;
    try {
      appendSessionTurn(sessionId, { cwd: "/repo", title: "one" }, [
        { role: "user", content: "one" },
      ]);
      assert.throws(
        () => rewindStoredSession(sessionId, 0),
        /positive integer/,
      );
      assert.throws(
        () => rewindStoredSession(sessionId, 2),
        /only 1 checkpoint is available/,
      );
    } finally {
      deleteStoredSession(sessionId);
    }
  });
});
