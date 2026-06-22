import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deriveTitle } from "../../src/acp/sessions.js";

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

  it("returns null when the first user message content is not a string", () => {
    assert.equal(deriveTitle([{ role: "user", content: [{ type: "text", text: "hi" }] as any }]), null);
  });

  it("returns the trimmed first user message", () => {
    assert.equal(deriveTitle([{ role: "user", content: "  hello there  " }]), "hello there");
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
