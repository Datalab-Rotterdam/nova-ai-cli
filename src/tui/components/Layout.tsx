import { Box } from "ink";
import React from "react";
import { useTerminalRows } from "../hooks/useTerminalRows.js";

export function Layout({ children }: { children: React.ReactNode }): React.ReactElement {
  const rows = useTerminalRows();

  return (
    <Box flexDirection="column" height={rows} overflowY="hidden">
      {children}
    </Box>
  );
}
