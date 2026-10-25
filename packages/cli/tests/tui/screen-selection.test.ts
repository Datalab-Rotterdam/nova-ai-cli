import assert from "node:assert/strict";
import { test } from "node:test";
import { ScreenSelection, sliceCells } from "../../src/tui/ink/screen-selection.js";
import { parseMouse } from "../../src/tui/ink/terminal-keyboard.js";

test("a selection copies the text of Ink's last frame and paints over it", () => {
  const written: string[] = [];
  const out = { columns: 10, write: (data: string) => written.push(data) };
  const selection = new ScreenSelection(out);
  const stdout = selection.wrap(out);
  // A frame as Ink's log-update writes it: erase the old one, then the new one.
  stdout.write("\u001b[2K\u001b[1A\u001b[2K\u001b[G\u001b[31mhello\u001b[39m world\n界a bc  \nlast\n");

  selection.set({ row: 0, col: 6 }, { row: 1, col: 2 });
  assert.equal(selection.text(), "world\n界a");
  assert.match(written.at(-1)!, /\u001b\[1;7H\u001b\[7mworld\u001b\[27m\u001b\[2;1H\u001b\[7m界a\u001b\[27m/);

  // Shift+Right wraps; a later frame keeps the selection painted.
  selection.set({ row: 1, col: 4 }, { row: 1, col: 9 });
  selection.extend(0, 1);
  assert.equal(selection.text(), "bc\nl");
  stdout.write("\u001b[2Knew frame here\nsecond");
  assert.equal(selection.text(), "nd");
  assert.match(written.at(-1)!, /\u001b\[2;5H\u001b\[7mnd\u001b\[27m/);

  // Clearing repaints the selected rows from the frame, colors included.
  selection.clear();
  assert.equal(selection.active, false);
  assert.match(written.at(-1)!, /\u001b\[2;1H\u001b\[0msecond/);
  // Writes without text (cursor moves) are not frames.
  stdout.write("\u001b[?25l");
  selection.set({ row: 0, col: 0 }, { row: 0, col: 2 });
  assert.equal(selection.text(), "new");
});

test("sliceCells counts wide characters by their width", () => {
  assert.deepEqual(sliceCells("a界b", 2, 3), { col: 1, text: "界b" });
  assert.deepEqual(sliceCells("ab", 5, 9), { col: 5, text: "" });
});

test("parseMouse reads SGR press, drag and release reports", () => {
  assert.deepEqual(parseMouse("[<0;3;7M"), { button: 0, col: 2, row: 6, release: false });
  assert.deepEqual(parseMouse("\u001b[<32;4;7M"), { button: 32, col: 3, row: 6, release: false });
  assert.deepEqual(parseMouse("[<0;4;7m"), { button: 0, col: 3, row: 6, release: true });
  assert.equal(parseMouse("hello"), null);
});
