import { Box, Text } from "ink";
import React from "react";
import { useTheme } from "../theme/index.js";

export function Banner({ cwd }: { cwd: string }): React.ReactElement {
  const theme = useTheme();
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={theme.primary} bold>
        Nova AI
      </Text>
      <Text color={theme.muted}>{cwd}</Text>
      <Text color={theme.muted}>
        /help for commands - Shift+Tab mode - Ctrl+R sessions - Ctrl+P models - Ctrl+K permissions - Ctrl+C to cancel/exit
      </Text>
    </Box>
  );
}
