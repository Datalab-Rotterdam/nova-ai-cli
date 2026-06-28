import { Box, Text, useInput } from "ink";
import React, { useEffect, useRef, useState } from "react";
import { AUTOCOMPLETE_MAX_ROWS } from "./FileAutocomplete.js";
import { useFileMentions } from "../hooks/useFileMentions.js";
import { useSlashCommands } from "../hooks/useSlashCommands.js";
import { useTextInput } from "../hooks/useTextInput.js";
import { useTheme } from "../theme/index.js";
import { FileAutocomplete } from "./FileAutocomplete.js";
import { SlashAutocomplete } from "./SlashAutocomplete.js";

export function InputBar({
  history,
  disabled,
  files,
  onSubmit,
  onHeightChange,
}: {
  history: string[];
  disabled: boolean;
  files: string[];
  onSubmit(value: string): void;
  onHeightChange?(height: number): void;
}): React.ReactElement {
  const theme = useTheme();
  const disableArrowHistoryRef = useRef(false);
  const { value, setValue, cursor } = useTextInput({
    history,
    onSubmit,
    disabled,
    disableArrowHistory: disableArrowHistoryRef.current,
  });
  const slashMatches = useSlashCommands(value);
  const { query, matches: fileMatches } = useFileMentions(value, files);
  const filePickerActive = query !== null && fileMatches.length > 0;
  const slashPickerActive = value.startsWith("/") && slashMatches.length > 0;
  disableArrowHistoryRef.current = filePickerActive || slashPickerActive;

  const [fileSelectedIndex, setFileSelectedIndex] = useState(0);
  const [slashSelectedIndex, setSlashSelectedIndex] = useState(0);
  useEffect(() => setFileSelectedIndex(0), [query]);
  useEffect(() => setSlashSelectedIndex(0), [value.startsWith("/") ? slashMatches.length : null]);

  const clampedFileIndex = Math.min(fileSelectedIndex, Math.max(0, fileMatches.length - 1));
  const clampedSlashIndex = Math.min(slashSelectedIndex, Math.max(0, slashMatches.length - 1));

  const ghostSuffix = (() => {
    if (!slashPickerActive || slashMatches.length === 0) return "";
    const topName = `/${slashMatches[clampedSlashIndex]!.name}`;
    if (topName.startsWith(value) && topName.length > value.length) return topName.slice(value.length);
    return "";
  })();

  useInput(
    (_input, key) => {
      if (filePickerActive) {
        if (key.upArrow) setFileSelectedIndex((i) => Math.max(0, i - 1));
        else if (key.downArrow) setFileSelectedIndex((i) => Math.min(fileMatches.length - 1, i + 1));
        else if (key.tab && !key.shift) {
          const lastAt = value.lastIndexOf("@");
          setValue(`${value.slice(0, lastAt)}@${fileMatches[clampedFileIndex]} `);
        }
      } else if (slashPickerActive) {
        if (key.upArrow) setSlashSelectedIndex((i) => Math.max(0, i - 1));
        else if (key.downArrow) setSlashSelectedIndex((i) => Math.min(slashMatches.length - 1, i + 1));
        else if (key.tab && !key.shift) {
          const cmd = slashMatches[clampedSlashIndex];
          if (cmd) setValue(`/${cmd.name} `);
        }
      }
    },
    { isActive: !disabled && (filePickerActive || slashPickerActive) },
  );

  // Compute cursor line/col for per-line rendering
  const lines = value.split("\n");
  const beforeCursor = value.slice(0, cursor);
  const beforeLines = beforeCursor.split("\n");
  const cursorLineIdx = beforeLines.length - 1;
  const cursorCol = beforeLines[cursorLineIdx]!.length;

  const autocompleteRows = slashPickerActive
    ? Math.min(slashMatches.length, AUTOCOMPLETE_MAX_ROWS)
    : Math.min(fileMatches.length, AUTOCOMPLETE_MAX_ROWS);
  const totalHeight = 2 /* border */ + lines.length + autocompleteRows;
  useEffect(() => onHeightChange?.(totalHeight), [totalHeight]);

  return (
    <Box flexDirection="column">
      <Box borderStyle="round" borderColor={disabled ? theme.muted : theme.primary} paddingX={1} flexDirection="column">
        {lines.map((line, i) => (
          <Box key={i}>
            <Text color={theme.muted}>{i === 0 ? "> " : "  "}</Text>
            {disabled ? (
              <Text>{line}</Text>
            ) : i === cursorLineIdx ? (
              <Text>
                {line.slice(0, cursorCol)}
                <Text color={theme.muted}>█</Text>
                {ghostSuffix
                  ? <Text color={theme.muted}>{ghostSuffix}</Text>
                  : null}
                {line.slice(cursorCol)}
              </Text>
            ) : (
              <Text>{line}</Text>
            )}
          </Box>
        ))}
      </Box>
      {slashPickerActive ? (
        <SlashAutocomplete matches={slashMatches} selectedIndex={clampedSlashIndex} />
      ) : (
        <FileAutocomplete matches={fileMatches} selectedIndex={clampedFileIndex} />
      )}
    </Box>
  );
}
