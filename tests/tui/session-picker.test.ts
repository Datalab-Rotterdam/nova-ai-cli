import assert from "node:assert/strict";
import test from "node:test";
import {
  formatDateTime,
  formatTimeAgo,
  oneLineTitle,
  toSessionPickerItem,
} from "../../src/tui/session/session-picker.js";

const NOW = Date.parse("2026-07-17T12:00:00.000Z");

test("session picker puts relative time first and normalizes the title to one line", () => {
  const item = toSessionPickerItem(
    {
      sessionId: "session-1",
      cwd: "/repo",
      title: "Investigate rendering\nthen fix the session picker",
      updatedAt: "2026-07-17T11:55:00.000Z",
      messages: [],
    },
    NOW,
  );

  assert.deepEqual(item, {
    value: "session-1",
    label: "5m ago",
    description: "Investigate rendering then fix the session picker",
    columns: {
      leading: "5m ago",
      main: "Investigate rendering then fix the session picker",
      trailing: "2026-07-17T11:55:00.000Z",
    },
  });
  assert.equal(item.description.includes("\n"), false);
});

test("relative session times stay compact across useful ranges", () => {
  assert.equal(formatTimeAgo("2026-07-17T11:59:58.000Z", NOW), "just now");
  assert.equal(formatTimeAgo("2026-07-17T11:59:18.000Z", NOW), "42s ago");
  assert.equal(formatTimeAgo("2026-07-17T09:00:00.000Z", NOW), "3h ago");
  assert.equal(formatTimeAgo("2026-07-14T12:00:00.000Z", NOW), "3d ago");
  assert.equal(formatTimeAgo("not-a-date", NOW), "unknown");
});

test("empty and whitespace-heavy titles remain one line", () => {
  assert.equal(oneLineTitle(null), "(untitled)");
  assert.equal(oneLineTitle("  first\tsecond\r\nthird  "), "first second third");
});

test("the exact datetime remains an unambiguous ISO timestamp", () => {
  assert.equal(
    formatDateTime("2026-07-17T11:55:00Z"),
    "2026-07-17T11:55:00.000Z",
  );
  assert.equal(formatDateTime("not-a-date"), "unknown");
});
