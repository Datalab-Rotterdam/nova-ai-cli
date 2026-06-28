import { Text } from "ink";
import React, { useEffect, useState } from "react";
import { useTheme } from "../theme/index.js";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function ThinkingIndicator({ busy }: { busy: boolean }): React.ReactElement | null {
  const theme = useTheme();
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (!busy) return;
    const id = setInterval(() => setFrame((f) => (f + 1) % FRAMES.length), 80);
    return () => clearInterval(id);
  }, [busy]);

  if (!busy) return null;

  return (
    <Text color={theme.primary}>
      {FRAMES[frame]} thinking…
    </Text>
  );
}
