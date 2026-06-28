import { Box, Text } from "ink";
import React, { useEffect, useState } from "react";
import type { BackgroundJobView as BackgroundJobViewModel } from "../state/types.js";
import { useTheme } from "../theme/index.js";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const STATUS_ICON: Record<BackgroundJobViewModel["status"], string> = {
  running: "○",
  completed: "✓",
  failed: "✗",
  killed: "■",
  released: "◇",
};

const MAX_PREVIEW_LINE_CHARS = 160;

export function BackgroundJobView({ job }: { job: BackgroundJobViewModel }): React.ReactElement {
  const theme = useTheme();
  const color = job.status === "completed" ? theme.success : job.status === "failed" || job.status === "killed" ? theme.error : theme.warning;
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (job.status !== "running") return;
    const id = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), 80);
    return () => clearInterval(id);
  }, [job.status]);
  const icon = job.status === "running" ? SPINNER_FRAMES[frame] : STATUS_ICON[job.status];

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={color} paddingX={1} marginBottom={1}>
      <Text color={color}>
        {icon} background {job.kind}: {job.title} [{job.status}]
      </Text>
      <Text color={theme.muted}>jobId: {job.jobId}</Text>
      {job.outputPath ? <Text color={theme.muted}>output: {job.outputPath}</Text> : null}
      {job.preview ? <Text color={theme.muted}>{truncateLines(job.preview, 8)}</Text> : <Text color={theme.muted}>No output yet.</Text>}
    </Box>
  );
}

function truncateLines(text: string, maxLines: number): string {
  const lines = text
    .trimEnd()
    .split(/\r?\n/)
    .map((line) => (line.length > MAX_PREVIEW_LINE_CHARS ? `${line.slice(0, MAX_PREVIEW_LINE_CHARS).trimEnd()}...` : line));
  if (lines.length <= maxLines) return lines.join("\n");
  return `${lines.slice(0, maxLines).join("\n")}\n... ${lines.length - maxLines} more lines`;
}
