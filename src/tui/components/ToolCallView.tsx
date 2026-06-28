import { Box, Text } from "ink";
import React, { useEffect, useState } from "react";
import type { ToolCallView as ToolCallViewModel } from "../state/types.js";
import { useTheme } from "../theme/index.js";
import { DiffView } from "./DiffView.js";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const STATUS_ICON: Record<ToolCallViewModel["status"], string> = {
  pending: "○",
  completed: "✓",
  failed: "✗",
};

const MAX_OUTPUT_LINES = 8;
const MAX_OUTPUT_CHARS = 800;
const MAX_OUTPUT_LINE_CHARS = 160;

export function ToolCallView({ call }: { call: ToolCallViewModel }): React.ReactElement {
  const theme = useTheme();
  const color = call.status === "completed" ? theme.success : call.status === "failed" ? theme.error : theme.warning;
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (call.status !== "pending") return;
    const id = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), 80);
    return () => clearInterval(id);
  }, [call.status]);
  const icon = call.status === "pending" ? SPINNER_FRAMES[frame] : STATUS_ICON[call.status];

  const isWrite = call.name === "write_file" && typeof call.args.path === "string" && typeof call.args.content === "string";

  return (
    <Box flexDirection="column" paddingLeft={1}>
      <Text color={color}>
        {icon} {call.name}
        {call.mutating ? " (mutating)" : ""} {summarizeArgs(call.args)}
      </Text>
      {isWrite && call.status === "completed" ? (
        <DiffView before="" after={String(call.args.content)} maxLines={12} />
      ) : call.output ? (
        <Text color={theme.muted}>{truncateOutput(call.output)}</Text>
      ) : null}
    </Box>
  );
}

function summarizeArgs(args: Record<string, unknown>): string {
  const path = typeof args.path === "string" ? args.path : undefined;
  const command = typeof args.command === "string" ? args.command : undefined;
  return truncateArg(path ?? command ?? "");
}

function truncateArg(value: string): string {
  return value.length > 120 ? `${value.slice(0, 120).trimEnd()}...` : value;
}

function truncateOutput(text: string): string {
  const trimmed = text.trimEnd();
  const lines = trimmed.split(/\r?\n/);
  const displayLines = lines.map((line) =>
    line.length > MAX_OUTPUT_LINE_CHARS ? `${line.slice(0, MAX_OUTPUT_LINE_CHARS).trimEnd()}...` : line,
  );
  const initialVisible = displayLines.slice(0, MAX_OUTPUT_LINES).join("\n");
  const visible = initialVisible.length > MAX_OUTPUT_CHARS ? initialVisible.slice(0, MAX_OUTPUT_CHARS).trimEnd() : initialVisible;
  const hiddenLines = Math.max(0, lines.length - visible.split(/\r?\n/).length);
  const hiddenChars = Math.max(0, trimmed.length - visible.length);

  if (hiddenLines === 0 && hiddenChars === 0) return visible;

  const details = [
    hiddenLines > 0 ? `${hiddenLines} more line${hiddenLines === 1 ? "" : "s"}` : null,
    hiddenChars > 0 ? `${hiddenChars} more char${hiddenChars === 1 ? "" : "s"}` : null,
  ].filter(Boolean);
  return `${visible}\n... output truncated (${details.join(", ")})`;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
