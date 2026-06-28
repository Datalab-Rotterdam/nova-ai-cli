import { Box, Text, useInput } from "ink";
import React, { useState } from "react";
import { useTheme } from "../theme/index.js";

export type ModelOption = { id: string; name?: string | null };

export function ModelPicker({
  models,
  currentModel,
  loading,
  onSelect,
  onCancel,
}: {
  models: ModelOption[];
  currentModel: string;
  loading: boolean;
  onSelect(modelId: string): void;
  onCancel(): void;
}): React.ReactElement {
  const theme = useTheme();
  const [selected, setSelected] = useState(0);
  const VISIBLE_CAP = 10;
  const visible = models.slice(0, VISIBLE_CAP);
  const hiddenCount = models.length - visible.length;

  useInput((_input, key) => {
    if (key.upArrow) setSelected((i) => Math.max(0, i - 1));
    else if (key.downArrow) setSelected((i) => Math.min(visible.length - 1, i + 1));
    else if (key.return && visible[selected]) onSelect(visible[selected].id);
    else if (key.escape) onCancel();
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.primary} paddingX={1} marginY={1}>
      <Text color={theme.primary} bold>
        Models — Enter to switch, Esc to cancel
      </Text>
      {loading ? (
        <Text color={theme.muted}>Loading models…</Text>
      ) : models.length === 0 ? (
        <Text color={theme.muted}>No tool-capable models available.</Text>
      ) : (
        visible.map((m, i) => (
          <Text key={m.id} color={i === selected ? theme.primary : undefined}>
            {i === selected ? "› " : "  "}
            {m.id === currentModel ? "* " : "  "}
            {m.id}
            {m.name ? <Text color={theme.muted}> — {m.name}</Text> : null}
          </Text>
        ))
      )}
      {hiddenCount > 0 ? <Text color={theme.muted}>… {hiddenCount} more</Text> : null}
    </Box>
  );
}
