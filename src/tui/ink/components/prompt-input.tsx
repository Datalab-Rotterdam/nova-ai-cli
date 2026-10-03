import { Box, Text, useInput, usePaste } from "ink";
import { useSyncExternalStore } from "react";
import type { KeyPress, PromptEditor } from "../editor/prompt-editor.js";
import { palette } from "../theme.js";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const MAX_SUGGESTIONS = 8;

export function PromptInput({
  editor,
  busy,
  maxRows,
  onKey,
}: {
  editor: PromptEditor;
  busy: boolean;
  /** Most editor lines shown at once; the view follows the cursor. */
  maxRows: number;
  /** Shortcuts get the key first; true means it was used. */
  onKey(input: string, key: KeyPress): boolean;
}) {
  useSyncExternalStore(editor.subscribe, editor.getVersion);
  useInput((input, key) => {
    if (onKey(input, key)) return;
    editor.handleKey(input, key);
  });
  usePaste((text) => editor.paste(text));

  const lines = editor.buffer.lineList;
  const { row, col } = editor.buffer.cursor;
  const visibleRows = Math.max(1, maxRows);
  const start = Math.min(
    Math.max(0, row - visibleRows + 1),
    Math.max(0, lines.length - visibleRows),
  );
  const shown = lines.slice(start, start + visibleRows);
  const autocomplete = editor.autocomplete;

  return (
    <Box flexDirection="column">
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={busy ? palette.warning : palette.primary}
        paddingRight={1}
      >
        {start > 0 ? <Text color={palette.faint}>{`  ↑ ${start} more line${start === 1 ? "" : "s"}`}</Text> : null}
        {shown.map((line, index) => {
          const lineIndex = start + index;
          return (
            <Box key={lineIndex}>
              <Box flexShrink={0}>
                <Text color={palette.primary}>{lineIndex === 0 ? "> " : "  "}</Text>
              </Box>
              <Box flexGrow={1} flexShrink={1}>
                <Text>{lineIndex === row ? withCursor(line, col) : line || " "}</Text>
              </Box>
            </Box>
          );
        })}
        {start + shown.length < lines.length ? (
          <Text color={palette.faint}>
            {`  ↓ ${lines.length - start - shown.length} more line${lines.length - start - shown.length === 1 ? "" : "s"}`}
          </Text>
        ) : null}
      </Box>
      {autocomplete ? <Suggestions view={autocomplete} /> : null}
    </Box>
  );
}

function Suggestions({ view }: { view: NonNullable<PromptEditor["autocomplete"]> }) {
  const count = view.items.length;
  const rows = Math.min(MAX_SUGGESTIONS, count);
  const start = Math.max(0, Math.min(view.selected - Math.floor(rows / 2), count - rows));
  return (
    <Box flexDirection="column" paddingLeft={2}>
      {view.items.slice(start, start + rows).map((item, index) => {
        const selected = start + index === view.selected;
        return (
          <Box key={`${item.value}:${start + index}`}>
            <Box flexShrink={0}>
              <Text color={selected ? palette.primary : undefined} bold={selected}>
                {`${selected ? "› " : "  "}${item.label}`}
              </Text>
            </Box>
            {item.description ? (
              <Box flexGrow={1} flexShrink={1} marginLeft={2}>
                <Text color={palette.muted} wrap="truncate-end">
                  {item.description}
                </Text>
              </Box>
            ) : null}
          </Box>
        );
      })}
      {count > rows ? (
        <Text color={palette.faint}>{`  ${view.selected + 1}/${count} · Tab accept · Esc close`}</Text>
      ) : null}
    </Box>
  );
}

/** The line with the grapheme under the cursor shown inverted. */
function withCursor(line: string, col: number) {
  const before = line.slice(0, col);
  const rest = line.slice(col);
  const first = segmenter.segment(rest)[Symbol.iterator]().next();
  const current = first.done ? " " : first.value.segment;
  const after = first.done ? "" : rest.slice(current.length);
  return (
    <>
      {before}
      <Text inverse>{current}</Text>
      {after}
    </>
  );
}
