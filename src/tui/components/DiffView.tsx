import { diffLines } from "diff";
import { Box, Text } from "ink";
import React from "react";
import { useTheme } from "../theme/index.js";

export function DiffView({ before, after, maxLines }: { before: string; after: string; maxLines?: number }): React.ReactElement {
  const theme = useTheme();
  const changes = diffLines(before, after);
  const lines = changes.flatMap((change, i) =>
    change.value
      .split("\n")
      .filter((line, idx, arr) => !(idx === arr.length - 1 && line === ""))
      .map((line, j) => ({
        key: `${i}-${j}`,
        line,
        prefix: change.added ? "+" : change.removed ? "-" : " ",
        color: change.added ? theme.diffAdded : change.removed ? theme.diffRemoved : undefined,
      })),
  );
  const visibleLines = maxLines === undefined ? lines : lines.slice(0, maxLines);

  return (
    <Box flexDirection="column">
      {visibleLines.map(({ key, color, prefix, line }) => (
        <Text key={key} color={color}>
          {prefix} {line}
        </Text>
      ))}
      {maxLines !== undefined && lines.length > maxLines ? (
        <Text color={theme.muted}>... diff truncated ({lines.length - maxLines} more lines)</Text>
      ) : null}
    </Box>
  );
}
