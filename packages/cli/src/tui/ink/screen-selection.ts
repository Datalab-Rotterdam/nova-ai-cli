import { stripVTControlCharacters } from "node:util";
import stringWidth from "string-width";

/** A screen cell, 0-based. */
export type Cell = { row: number; col: number };

type Output = { write(data: string): unknown; columns?: number };

// Cursor moves, erases and sync markers Ink wraps around a frame: every CSI
// but SGR colors (`m`), plus save/restore cursor and reset.
const CONTROL_RUN = "(?:\\u001b\\[[\\d;?]*[A-LN-Za-ln-z]|\\u001b[78c])*";
const LEADING_CONTROLS = new RegExp(`^${CONTROL_RUN}`);
const TRAILING_CONTROLS = new RegExp(`${CONTROL_RUN}$`);
const graphemes = new Intl.Segmenter();

/**
 * Text selection drawn by the app itself, so the mouse can select while it
 * also scrolls the transcript. Ink knows nothing about screen cells, so this
 * keeps the last frame Ink wrote and paints the selection over it (inverse).
 *
 * ponytail: relies on Ink repainting the whole frame on every change (its
 * default, non-incremental log-update) on the alternate screen, so a frame
 * starts at row 1. With `incrementalRendering` the captured chunk is a diff.
 * The selection is in screen cells: output that moves under it is not followed.
 */
export class ScreenSelection {
  private rawLines: string[] = [];
  private plainLines: string[] = [];
  private anchor: Cell | null = null;
  private focus: Cell = { row: 0, col: 0 };

  constructor(private readonly out: Output) {}

  /** The stream to hand Ink: writes go through, frames are kept and painted over. */
  wrap<T extends object>(stdout: T): T {
    return new Proxy(stdout, {
      get: (target, key) => {
        if (key === "write") return this.write(target as unknown as Output);
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  get active(): boolean {
    return this.anchor !== null;
  }

  set(anchor: Cell, focus: Cell): void {
    this.repaint(() => {
      this.anchor = anchor;
      this.focus = focus;
    });
  }

  /** Shift+arrows: moves the selection's moving end, wrapping at the row edges. */
  extend(rows: number, cols: number): void {
    if (!this.anchor) return;
    const width = this.out.columns ?? 80;
    let { row, col } = this.focus;
    col += cols;
    if (col < 0) [row, col] = [row - 1, width - 1];
    if (col >= width) [row, col] = [row + 1, 0];
    row = Math.max(0, Math.min(row + rows, this.plainLines.length - 1));
    this.set(this.anchor, { row, col });
  }

  clear(): void {
    if (this.anchor) this.repaint(() => (this.anchor = null));
  }

  text(): string {
    return this.segments()
      .map(({ text }) => text.trimEnd())
      .join("\n");
  }

  private write(target: Output) {
    return (chunk: unknown, ...rest: unknown[]) => {
      const result = (target.write as (...args: unknown[]) => unknown).call(target, chunk, ...rest);
      if (typeof chunk === "string" && this.capture(chunk) && this.anchor) this.out.write(this.overlay());
      return result;
    };
  }

  private capture(chunk: string): boolean {
    const frame = chunk.replace(LEADING_CONTROLS, "").replace(TRAILING_CONTROLS, "");
    const plain = stripVTControlCharacters(frame);
    if (!plain.trim()) return false;
    this.rawLines = frame.split("\n");
    this.plainLines = plain.split("\n");
    return true;
  }

  /** Restores the rows under the old selection, then paints the new one. */
  private repaint(change: () => void): void {
    const restore = this.segments()
      .map(({ row }) => `\u001b[${row + 1};1H\u001b[0m${this.rawLines[row] ?? ""}\u001b[0m`)
      .join("");
    change();
    this.out.write(`\u001b7${restore}${this.overlay(false)}\u001b8`);
  }

  private overlay(saveCursor = true): string {
    const paint = this.segments()
      .filter(({ text }) => text)
      .map(({ row, col, text }) => `\u001b[${row + 1};${col + 1}H\u001b[7m${text}\u001b[27m`)
      .join("");
    return saveCursor ? `\u001b7${paint}\u001b8` : paint;
  }

  /** Each selected row's text and the cell it starts at, top to bottom. */
  private segments(): Array<{ row: number; col: number; text: string }> {
    if (!this.anchor) return [];
    const [start, end] = before(this.anchor, this.focus)
      ? [this.anchor, this.focus]
      : [this.focus, this.anchor];
    const segments = [];
    for (let row = start.row; row <= Math.min(end.row, this.plainLines.length - 1); row++) {
      const from = row === start.row ? start.col : 0;
      const to = row === end.row ? end.col : Infinity;
      segments.push({ row, ...sliceCells(this.plainLines[row] ?? "", from, to) });
    }
    return segments;
  }
}

function before(a: Cell, b: Cell): boolean {
  return a.row < b.row || (a.row === b.row && a.col <= b.col);
}

/** The characters covering cells `from`..`to` (inclusive), wide ones counted by width. */
export function sliceCells(line: string, from: number, to: number): { col: number; text: string } {
  let col = 0;
  let start = -1;
  let text = "";
  for (const { segment } of graphemes.segment(line)) {
    if (col > to) break;
    const width = stringWidth(segment);
    if (col + Math.max(width, 1) - 1 >= from) {
      if (start < 0) start = col;
      text += segment;
    }
    col += width;
  }
  return { col: start < 0 ? from : start, text };
}
