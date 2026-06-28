import { Box, Text, useInput } from "ink";
import React, { useState } from "react";
import type { PermissionMode } from "../state/types.js";
import { useTheme } from "../theme/index.js";

const OPTIONS: Array<{ id: PermissionMode; label: string; description: string }> = [
  { id: "ask", label: "ask", description: "Prompt before every mutating tool call (default)." },
  { id: "acceptEdits", label: "acceptEdits", description: "Auto-allow file writes, still prompt for shell commands." },
  { id: "bypassAll", label: "bypassAll", description: "Auto-allow every tool call, no prompts." },
];

export function PermissionModePicker({
  currentMode,
  onSelect,
  onCancel,
}: {
  currentMode: PermissionMode;
  onSelect(mode: PermissionMode): void;
  onCancel(): void;
}): React.ReactElement {
  const theme = useTheme();
  const [selected, setSelected] = useState(Math.max(0, OPTIONS.findIndex((o) => o.id === currentMode)));

  useInput((_input, key) => {
    if (key.upArrow) setSelected((i) => Math.max(0, i - 1));
    else if (key.downArrow) setSelected((i) => Math.min(OPTIONS.length - 1, i + 1));
    else if (key.return) onSelect(OPTIONS[selected].id);
    else if (key.escape) onCancel();
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.primary} paddingX={1} marginY={1}>
      <Text color={theme.primary} bold>
        Permission mode — Enter to switch, Esc to cancel
      </Text>
      {OPTIONS.map((opt, i) => (
        <Text key={opt.id} color={i === selected ? theme.primary : undefined}>
          {i === selected ? "› " : "  "}
          {opt.id === currentMode ? "* " : "  "}
          {opt.label} <Text color={theme.muted}>— {opt.description}</Text>
        </Text>
      ))}
    </Box>
  );
}
