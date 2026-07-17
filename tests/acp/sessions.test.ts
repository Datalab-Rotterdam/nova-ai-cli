import assert from "node:assert/strict";
import { describe, it, test } from "node:test";
import {
  appendSessionTurn,
  deleteStoredSession,
  deriveTitle,
  forkStoredSession,
  loadStoredSession,
  parseSessionFile,
} from "../../src/acp/sessions.js";

// loadStoredSession/appendSessionTurn/listStoredSessions resolve SESSIONS_DIR
// from homedir() at module-load time, so they aren't unit-testable without
// touching the real ~/.nova-ai directory. Only the pure deriveTitle logic
// is covered here.
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
