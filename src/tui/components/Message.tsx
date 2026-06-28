import { Box, Text } from "ink";
import React, { useEffect, useState } from "react";
import type { UIMessage } from "../state/types.js";
import { useTheme } from "../theme/index.js";
import { Markdown } from "./Markdown.js";
import { BackgroundJobView } from "./BackgroundJobView.js";
import { ToolCallView } from "./ToolCallView.js";

const ICON_FRAMES = ["✦", "✧", "·", "✧"];

const USER_MESSAGE_LINES = 3;
const USER_MESSAGE_CHARS = 500;
const ERROR_MESSAGE_LINES = 4;
const ERROR_MESSAGE_CHARS = 800;

function useAnimatedIcon(active: boolean): string {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setFrame((f) => (f + 1) % ICON_FRAMES.length), 450);
    return () => clearInterval(id);
  }, [active]);
  return active ? ICON_FRAMES[frame] : ICON_FRAMES[0];
}

export function Message({ message }: { message: UIMessage }): React.ReactElement {
  const theme = useTheme();

  if (message.role === "user") {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text color={theme.primary} bold>
          {"> "}
          {clampText(message.text, USER_MESSAGE_LINES, USER_MESSAGE_CHARS)}
        </Text>
      </Box>
    );
  }

  if (message.role === "error") {
    return (
      <Box marginBottom={1}>
        <Text color={theme.error}>{clampText(message.text, ERROR_MESSAGE_LINES, ERROR_MESSAGE_CHARS)}</Text>
      </Box>
    );
  }

  if (message.role === "tool") {
    return (
      <Box marginBottom={1}>
        <ToolCallView call={message.call} />
      </Box>
    );
  }

  if (message.role === "background") {
    return <BackgroundJobView job={message.job} />;
  }

  return <AssistantMessage message={message} />;
}

function AssistantMessage({ message }: { message: Extract<UIMessage, { role: "assistant" }> }): React.ReactElement {
  const theme = useTheme();
  const icon = useAnimatedIcon(message.streaming);
  const iconColor = message.streaming ? theme.secondary : theme.primary;
  const thinking = message.streaming && !message.text;

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box gap={1}>
        <Text color={iconColor}>{icon}</Text>
        <Box flexDirection="column" flexShrink={1}>
          {thinking ? (
            <Text color={theme.muted}>Thinking…</Text>
          ) : (
            <Markdown text={message.text || ""} />
          )}
        </Box>
      </Box>
    </Box>
  );
}

function clampText(text: string, maxLines: number, maxChars: number): string {
  const trimmed = text.trimEnd();
  const lines = trimmed.split(/\r?\n/);
  const byLines = lines.slice(0, maxLines).join("\n");
  const visible = byLines.length > maxChars ? byLines.slice(0, maxChars).trimEnd() : byLines;
  const hiddenLines = Math.max(0, lines.length - visible.split(/\r?\n/).length);
  const hiddenChars = Math.max(0, trimmed.length - visible.length);

  if (hiddenLines === 0 && hiddenChars === 0) return visible;

  const details = [
    hiddenLines > 0 ? `${hiddenLines} more line${hiddenLines === 1 ? "" : "s"}` : null,
    hiddenChars > 0 ? `${hiddenChars} more char${hiddenChars === 1 ? "" : "s"}` : null,
  ].filter(Boolean);
  return `${visible}\n... message truncated (${details.join(", ")})`;
}
