import { useInput } from "ink";
import { useState } from "react";

export type UseTextInputOptions = {
  disabled?: boolean;
  disableArrowHistory?: boolean;
  history: string[];
  onSubmit(value: string): void;
};

function cursorUp(value: string, pos: number): number {
  const before = value.slice(0, pos);
  const lastNl = before.lastIndexOf("\n");
  if (lastNl === -1) return -1;
  const col = pos - lastNl - 1;
  const prevLineEnd = lastNl;
  const prevLineStart = before.lastIndexOf("\n", lastNl - 1) + 1;
  return prevLineStart + Math.min(col, prevLineEnd - prevLineStart);
}

function cursorDown(value: string, pos: number): number {
  const nextNl = value.indexOf("\n", pos);
  if (nextNl === -1) return -1;
  const before = value.slice(0, pos);
  const lineStart = before.lastIndexOf("\n") + 1;
  const col = pos - lineStart;
  const nextLineStart = nextNl + 1;
  const nextNl2 = value.indexOf("\n", nextLineStart);
  const nextLineLen = nextNl2 === -1 ? value.length - nextLineStart : nextNl2 - nextLineStart;
  return nextLineStart + Math.min(col, nextLineLen);
}

// Ink v5's parseKeypress doesn't map kitty/modifyOtherKeys Shift+Enter to key.return.
// These raw sequences arrive as `input` after Ink strips the leading ESC.
const SHIFT_ENTER_SEQUENCES = new Set([
  "[13;2u",   // kitty keyboard protocol (Windows Terminal, Ghostty, kitty)
  "[27;2;13~", // modifyOtherKeys (xterm/Ghostty over SSH)
]);

export function useTextInput({ disabled, disableArrowHistory, history, onSubmit }: UseTextInputOptions) {
  const [value, setValue] = useState("");
  const [cursor, setCursor] = useState(0);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);

  const setValueAndCursor = (v: string, c: number) => {
    setValue(v);
    setCursor(Math.max(0, Math.min(c, v.length)));
  };

  const insertNewline = (pos: number, val: string) => {
    const next = val.slice(0, pos) + "\n" + val.slice(pos);
    setValueAndCursor(next, pos + 1);
  };

  useInput(
    (input, key) => {
      // --- Enter / newline ---
      if (key.return) {
        // Backslash immediately before cursor: replace it with a newline
        if (cursor > 0 && value[cursor - 1] === "\\") {
          const next = value.slice(0, cursor - 1) + "\n" + value.slice(cursor);
          setValueAndCursor(next, cursor); // cursor stays numerically same = now after \n
          return;
        }
        if (key.shift) {
          insertNewline(cursor, value);
          return;
        }
        const text = value.trim();
        setValue("");
        setCursor(0);
        setHistoryIndex(null);
        if (text) onSubmit(text);
        return;
      }

      // Kitty / modifyOtherKeys Shift+Enter: arrives as raw stripped sequence in `input`
      if (SHIFT_ENTER_SEQUENCES.has(input)) {
        insertNewline(cursor, value);
        return;
      }

      // --- Arrow keys ---
      if (key.leftArrow) {
        if (key.ctrl || key.meta) {
          let i = cursor - 1;
          while (i > 0 && value[i] === " ") i--;
          while (i > 0 && value[i - 1] !== " " && value[i - 1] !== "\n") i--;
          setCursor(Math.max(0, i));
        } else {
          setCursor((c) => Math.max(0, c - 1));
        }
        return;
      }

      if (key.rightArrow) {
        if (key.ctrl || key.meta) {
          let i = cursor;
          while (i < value.length && value[i] === " ") i++;
          while (i < value.length && value[i] !== " " && value[i] !== "\n") i++;
          setCursor(Math.min(value.length, i));
        } else {
          setCursor((c) => Math.min(value.length, c + 1));
        }
        return;
      }

      if (key.upArrow) {
        const linePos = cursorUp(value, cursor);
        if (linePos !== -1) {
          setCursor(linePos);
          return;
        }
        if (disableArrowHistory || history.length === 0) return;
        const nextIndex = historyIndex === null ? history.length - 1 : Math.max(0, historyIndex - 1);
        setHistoryIndex(nextIndex);
        const next = history[nextIndex] ?? "";
        setValueAndCursor(next, next.length);
        return;
      }

      if (key.downArrow) {
        const linePos = cursorDown(value, cursor);
        if (linePos !== -1) {
          setCursor(linePos);
          return;
        }
        if (disableArrowHistory || historyIndex === null) return;
        const nextIndex = historyIndex + 1;
        if (nextIndex >= history.length) {
          setHistoryIndex(null);
          setValueAndCursor("", 0);
        } else {
          setHistoryIndex(nextIndex);
          const next = history[nextIndex] ?? "";
          setValueAndCursor(next, next.length);
        }
        return;
      }

      // --- Delete / backspace ---
      // Ink maps physical Backspace (\x7f) to key.delete, not key.backspace.
      // key.backspace is only Ctrl+H (\x08). Treat both as backward delete.
      if (key.backspace || key.delete) {
        if (cursor === 0) return;
        const next = value.slice(0, cursor - 1) + value.slice(cursor);
        setValueAndCursor(next, cursor - 1);
        return;
      }

      // --- Ctrl shortcuts ---
      if (key.ctrl) {
        switch (input) {
          case "a": setCursor(0); return;
          case "d": {
            // forward delete
            if (cursor < value.length) {
              setValueAndCursor(value.slice(0, cursor) + value.slice(cursor + 1), cursor);
            }
            return;
          }
          case "e": setCursor(value.length); return;
          case "u": {
            // kill to start of line
            const lineStart = value.lastIndexOf("\n", cursor - 1) + 1;
            setValueAndCursor(value.slice(0, lineStart) + value.slice(cursor), lineStart);
            return;
          }
          case "w": {
            // kill word before cursor
            let i = cursor - 1;
            while (i > 0 && value[i] === " ") i--;
            while (i > 0 && value[i - 1] !== " " && value[i - 1] !== "\n") i--;
            setValueAndCursor(value.slice(0, i) + value.slice(cursor), i);
            return;
          }
        }
        // swallow other ctrl combos so they don't insert escape sequences
        return;
      }

      if (key.meta) return;

      // --- Regular character input ---
      if (input) {
        const next = value.slice(0, cursor) + input + value.slice(cursor);
        setValueAndCursor(next, cursor + input.length);
      }
    },
    { isActive: !disabled },
  );

  return { value, setValue: (v: string) => setValueAndCursor(v, v.length), cursor };
}
