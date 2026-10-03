const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Offsets of grapheme boundaries in `text`, including 0 and text.length. */
function boundaries(text: string): number[] {
  const result = [0];
  for (const { index, segment } of segmenter.segment(text)) {
    result.push(index + segment.length);
  }
  return result;
}

function previousBoundary(text: string, offset: number): number {
  let previous = 0;
  for (const boundary of boundaries(text)) {
    if (boundary >= offset) return previous;
    previous = boundary;
  }
  return previous;
}

function nextBoundary(text: string, offset: number): number {
  for (const boundary of boundaries(text)) {
    if (boundary > offset) return boundary;
  }
  return text.length;
}

const WORD = /[\p{L}\p{N}_]/u;

/**
 * A multi-line text buffer with a cursor. Columns are UTF-16 offsets that
 * always sit on grapheme boundaries, so emoji and combined characters move
 * and delete as one unit.
 */
export class TextBuffer {
  private lines: string[] = [""];
  private row = 0;
  private col = 0;
  /** Column the cursor tries to keep while moving up and down. */
  private preferredCol: number | null = null;

  get text(): string {
    return this.lines.join("\n");
  }

  get cursor(): { row: number; col: number } {
    return { row: this.row, col: this.col };
  }

  get lineList(): readonly string[] {
    return this.lines;
  }

  get isEmpty(): boolean {
    return this.lines.length === 1 && this.lines[0] === "";
  }

  setText(text: string): void {
    this.lines = text.split("\n");
    this.row = this.lines.length - 1;
    this.col = this.lines[this.row]!.length;
    this.preferredCol = null;
  }

  /** Replaces the lines and cursor at once (used by autocomplete). */
  setState(lines: string[], row: number, col: number): void {
    this.lines = lines.length ? [...lines] : [""];
    this.row = Math.max(0, Math.min(row, this.lines.length - 1));
    this.col = Math.max(0, Math.min(col, this.lines[this.row]!.length));
    this.preferredCol = null;
  }

  insert(text: string): void {
    if (!text) return;
    const line = this.lines[this.row]!;
    const before = line.slice(0, this.col);
    const after = line.slice(this.col);
    const parts = text.split("\n");
    if (parts.length === 1) {
      this.lines[this.row] = before + text + after;
      this.col += text.length;
    } else {
      const last = parts.at(-1)!;
      const inserted = [before + parts[0], ...parts.slice(1, -1), last + after];
      this.lines.splice(this.row, 1, ...inserted);
      this.row += parts.length - 1;
      this.col = last.length;
    }
    this.preferredCol = null;
  }

  newline(): void {
    this.insert("\n");
  }

  backspace(): boolean {
    if (this.col > 0) {
      const line = this.lines[this.row]!;
      const start = previousBoundary(line, this.col);
      this.lines[this.row] = line.slice(0, start) + line.slice(this.col);
      this.col = start;
    } else if (this.row > 0) {
      const previous = this.lines[this.row - 1]!;
      this.lines.splice(this.row - 1, 2, previous + this.lines[this.row]!);
      this.row--;
      this.col = previous.length;
    } else {
      return false;
    }
    this.preferredCol = null;
    return true;
  }

  deleteForward(): boolean {
    const line = this.lines[this.row]!;
    if (this.col < line.length) {
      const end = nextBoundary(line, this.col);
      this.lines[this.row] = line.slice(0, this.col) + line.slice(end);
    } else if (this.row < this.lines.length - 1) {
      this.lines.splice(this.row, 2, line + this.lines[this.row + 1]!);
    } else {
      return false;
    }
    this.preferredCol = null;
    return true;
  }

  deleteWordBackward(): boolean {
    if (this.col === 0) return this.backspace();
    const line = this.lines[this.row]!;
    const start = this.wordStartBefore(line, this.col);
    this.lines[this.row] = line.slice(0, start) + line.slice(this.col);
    this.col = start;
    this.preferredCol = null;
    return true;
  }

  deleteToLineStart(): boolean {
    if (this.col === 0) return this.backspace();
    const line = this.lines[this.row]!;
    this.lines[this.row] = line.slice(this.col);
    this.col = 0;
    this.preferredCol = null;
    return true;
  }

  deleteToLineEnd(): boolean {
    const line = this.lines[this.row]!;
    if (this.col === line.length) return this.deleteForward();
    this.lines[this.row] = line.slice(0, this.col);
    this.preferredCol = null;
    return true;
  }

  left(): void {
    if (this.col > 0) {
      this.col = previousBoundary(this.lines[this.row]!, this.col);
    } else if (this.row > 0) {
      this.row--;
      this.col = this.lines[this.row]!.length;
    }
    this.preferredCol = null;
  }

  right(): void {
    const line = this.lines[this.row]!;
    if (this.col < line.length) {
      this.col = nextBoundary(line, this.col);
    } else if (this.row < this.lines.length - 1) {
      this.row++;
      this.col = 0;
    }
    this.preferredCol = null;
  }

  wordLeft(): void {
    if (this.col === 0) {
      this.left();
      return;
    }
    this.col = this.wordStartBefore(this.lines[this.row]!, this.col);
    this.preferredCol = null;
  }

  wordRight(): void {
    const line = this.lines[this.row]!;
    if (this.col === line.length) {
      this.right();
      return;
    }
    let offset = this.col;
    while (offset < line.length && !WORD.test(line[offset]!)) offset++;
    while (offset < line.length && WORD.test(line[offset]!)) offset++;
    this.col = offset;
    this.preferredCol = null;
  }

  /** Moves up one line; false when already on the first line. */
  up(): boolean {
    if (this.row === 0) return false;
    this.moveVertically(-1);
    return true;
  }

  /** Moves down one line; false when already on the last line. */
  down(): boolean {
    if (this.row === this.lines.length - 1) return false;
    this.moveVertically(1);
    return true;
  }

  lineStart(): void {
    this.col = 0;
    this.preferredCol = null;
  }

  lineEnd(): void {
    this.col = this.lines[this.row]!.length;
    this.preferredCol = null;
  }

  private moveVertically(delta: -1 | 1): void {
    this.preferredCol ??= this.col;
    this.row += delta;
    const line = this.lines[this.row]!;
    this.col = snapToBoundary(line, Math.min(this.preferredCol, line.length));
  }

  private wordStartBefore(line: string, offset: number): number {
    let start = offset;
    while (start > 0 && !WORD.test(line[start - 1]!)) start--;
    while (start > 0 && WORD.test(line[start - 1]!)) start--;
    return start;
  }
}

function snapToBoundary(text: string, offset: number): number {
  let result = 0;
  for (const boundary of boundaries(text)) {
    if (boundary > offset) break;
    result = boundary;
  }
  return result;
}
