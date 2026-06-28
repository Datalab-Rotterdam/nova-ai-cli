import { Box, Text, useInput } from "ink";
import React, { useState } from "react";
import type { StoredSession } from "../../acp/sessions.js";
import { useTheme } from "../theme/index.js";

export function SessionSwitcher({
  sessions,
  onSelect,
  onCancel,
}: {
  sessions: StoredSession[];
  onSelect(sessionId: string): void;
  onCancel(): void;
}): React.ReactElement {
  const theme = useTheme();
  const [selected, setSelected] = useState(0);
  const VISIBLE_CAP = 10;
  const visible = sessions.slice(0, VISIBLE_CAP);
  const hiddenCount = sessions.length - visible.length;

  useInput((_input, key) => {
    if (key.upArrow) setSelected((i) => Math.max(0, i - 1));
    else if (key.downArrow) setSelected((i) => Math.min(visible.length - 1, i + 1));
    else if (key.return && visible[selected]) onSelect(visible[selected].sessionId);
    else if (key.escape) onCancel();
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.primary} paddingX={1} marginY={1}>
      <Text color={theme.primary} bold>
        Sessions ({sessions.length}) — Enter to resume, Esc to cancel
      </Text>
      {sessions.length === 0 ? (
        <Text color={theme.muted}>No saved sessions for this workspace.</Text>
      ) : (
        visible.map((s, i) => (
          <Text key={s.sessionId} color={i === selected ? theme.primary : undefined}>
            {i === selected ? "› " : "  "}
            {s.title ?? "(untitled)"} <Text color={theme.muted}>— {s.updatedAt}</Text>
          </Text>
        ))
      )}
      {hiddenCount > 0 ? <Text color={theme.muted}>… {hiddenCount} more</Text> : null}
    </Box>
  );
}
