import { Box, Text } from "ink";
import React from "react";
import { useTheme } from "../theme/index.js";

export const AUTOCOMPLETE_MAX_ROWS = 8;

export function FileAutocomplete({
  matches,
  selectedIndex,
}: {
  matches: string[];
  selectedIndex: number;
}): React.ReactElement | null {
  const theme = useTheme();
  if (matches.length === 0) return null;

  return (
    <Box flexDirection="column" paddingLeft={1}>
      {matches.slice(0, AUTOCOMPLETE_MAX_ROWS).map((path, i) => (
        <Text key={path} color={i === selectedIndex ? theme.primary : theme.muted}>
          {i === selectedIndex ? "› " : "  "}@{path}
        </Text>
      ))}
    </Box>
  );
}
