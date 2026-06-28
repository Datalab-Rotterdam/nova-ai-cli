import { Box, Text } from "ink";
import React from "react";
import type { SlashCommand } from "../commands/index.js";
import { useTheme } from "../theme/index.js";
import { AUTOCOMPLETE_MAX_ROWS } from "./FileAutocomplete.js";

export function SlashAutocomplete({
  matches,
  selectedIndex,
}: {
  matches: SlashCommand[];
  selectedIndex: number;
}): React.ReactElement | null {
  const theme = useTheme();
  if (matches.length === 0) return null;

  return (
    <Box flexDirection="column" paddingLeft={1}>
      {matches.slice(0, AUTOCOMPLETE_MAX_ROWS).map((c, i) => (
        <Text key={c.name} color={i === selectedIndex ? theme.primary : theme.muted}>
          {i === selectedIndex ? "› " : "  "}/{c.name}{" "}
          <Text color={theme.muted}>— {c.description}</Text>
        </Text>
      ))}
    </Box>
  );
}
