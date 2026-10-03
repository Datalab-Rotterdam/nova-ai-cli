import { Box, Text } from "ink";
import type { ReactNode } from "react";
import type { PlanEntryView, ToolCallView } from "../../state/types.js";
import {
  activityDetails,
  activityStatus,
  activitySummary,
  changedLines,
  formatToolCallDetails,
  isCompactTool,
  outputLines,
  toolCallSummary,
} from "../format.js";
import type { TranscriptBlock } from "../transcript/committer.js";
import { ASSISTANT_MARKER, palette, WORKING_FRAMES } from "../theme.js";
import { Markdown } from "./markdown.js";

/** Collapsed diffs show this many changed lines; Ctrl+O or Ctrl+T show all. */
export const COLLAPSED_DIFF_LINES = 40;

type BlockProps = { block: TranscriptBlock; frame?: number };

export function TranscriptBlockView({ block, frame = 0 }: BlockProps): ReactNode {
  switch (block.kind) {
    case "header":
      return (
        <Box flexDirection="column" paddingLeft={2}>
          <Text color={palette.primary}>{`${ASSISTANT_MARKER} Nova AI`}</Text>
          <Text color={palette.muted}>{`Workspace: ${block.cwd}`}</Text>
          <Text color={palette.faint}>Ask a question, use @file, or type /help.</Text>
        </Box>
      );
    case "user":
      return (
        <Prefixed prefix="> " color={palette.primary}>
          <Text color={palette.primary}>{block.text}</Text>
        </Prefixed>
      );
    case "queued": {
      const label = block.queued === "steer" ? "steer" : "queued";
      return (
        <Prefixed prefix={`${label}> `} color={palette.warning}>
          <Text color={palette.muted}>
            {block.text || "(empty; press Enter to remove from queue)"}
          </Text>
        </Prefixed>
      );
    }
    case "assistant": {
      const text = block.first ? block.text.replace(/^\s+/, "") : block.text;
      return (
        <Prefixed prefix={block.first ? `${ASSISTANT_MARKER} ` : "  "} color={palette.accent}>
          <Markdown text={text.trimEnd()} />
        </Prefixed>
      );
    }
    case "error":
      return (
        <Prefixed prefix="! " color={palette.danger}>
          <Text color={palette.danger}>{block.text}</Text>
        </Prefixed>
      );
    case "tool":
      return <ToolCallBlock call={block.call} expanded={block.expanded} frame={frame} />;
    case "activity":
      return <ActivityBlock calls={block.calls} frame={frame} />;
    case "background": {
      const { job } = block;
      const color =
        job.status === "failed" || job.status === "killed"
          ? palette.danger
          : job.status === "completed"
            ? palette.success
            : palette.warning;
      return (
        <Box flexDirection="column" paddingLeft={1}>
          <Text>
            <Text color={palette.accent}>background</Text>
            {` ${job.kind}: ${job.title} [`}
            <Text color={color}>{job.status}</Text>
            {"]"}
          </Text>
          {block.expanded && job.preview ? (
            <Box paddingLeft={2}>
              <Text color={palette.muted}>{job.preview}</Text>
            </Box>
          ) : null}
        </Box>
      );
    }
    case "plan":
      return <PlanView entries={block.entries} frame={frame} />;
  }
}

function Prefixed({
  prefix,
  color,
  children,
}: {
  prefix: string;
  color: string;
  children: ReactNode;
}) {
  return (
    <Box paddingLeft={1}>
      <Box flexShrink={0}>
        <Text color={color}>{prefix}</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1} flexShrink={1}>
        {children}
      </Box>
    </Box>
  );
}

export function StatusIcon({
  status,
  frame = 0,
}: {
  status: ToolCallView["status"];
  frame?: number;
}) {
  if (status === "pending")
    return <Text color={palette.warning}>{WORKING_FRAMES[frame % WORKING_FRAMES.length]}</Text>;
  if (status === "failed") return <Text color={palette.danger}>!</Text>;
  return <Text color={palette.success}>✓</Text>;
}

export function ToolCallBlock({
  call,
  expanded,
  frame = 0,
}: {
  call: ToolCallView;
  expanded: boolean;
  frame?: number;
}) {
  const summary = toolCallSummary(call);
  const failure = outputLines(call.output).slice(-3);
  return (
    <Box flexDirection="column" paddingLeft={1}>
      <Text>
        <StatusIcon status={call.status} frame={frame} />{" "}
        <Text color={palette.accent}>{call.name}</Text>
        {call.mutating ? <Text color={palette.warning}> (changes)</Text> : null}
        {summary ? `: ${summary}` : ""}
      </Text>
      {call.status === "failed" ? (
        <Box paddingLeft={2}>
          <Text color={palette.danger}>
            {failure.length ? failure.join("\n") : "Tool failed."}
          </Text>
        </Box>
      ) : call.diff ? (
        <DiffView
          oldText={call.diff.oldText ?? ""}
          newText={call.diff.newText}
          path={call.diff.path}
          limit={expanded ? undefined : COLLAPSED_DIFF_LINES}
        />
      ) : expanded && !isCompactTool(call) ? (
        <Box paddingLeft={2}>
          <Text color={palette.muted}>{formatToolCallDetails(call)}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

export function ActivityBlock({
  calls,
  frame = 0,
}: {
  calls: ToolCallView[];
  frame?: number;
}) {
  const status = activityStatus(calls);
  const pending = status === "pending";
  const details = activityDetails(calls);
  return (
    <Box flexDirection="column" paddingLeft={1}>
      <Text>
        <StatusIcon status={status} frame={frame} />{" "}
        <Text color={palette.accent}>{activitySummary(calls, pending)}</Text>
        {pending ? <Text color={palette.faint}>…</Text> : null}
      </Text>
      {details.map((detail, index) => (
        <Box key={index}>
          <Text color={palette.faint}>{index === 0 ? "  ⎿  " : "     "}</Text>
          <Text color={palette.muted} wrap="truncate-end">
            {detail}
          </Text>
        </Box>
      ))}
    </Box>
  );
}

export function DiffView({
  oldText,
  newText,
  path,
  limit,
}: {
  oldText: string;
  newText: string;
  path: string | null | undefined;
  limit?: number;
}) {
  const changes = changedLines(oldText, newText, path);
  if (changes.length === 0)
    return (
      <Box paddingLeft={3}>
        <Text color={palette.faint}>no textual changes</Text>
      </Box>
    );
  const shown = limit === undefined ? changes : changes.slice(0, limit);
  const hidden = changes.length - shown.length;
  return (
    <Box flexDirection="column">
      {shown.map((line, index) => (
        <Box key={index}>
          <Box flexShrink={0}>
            <Text>
              {"   "}
              <Text color={line.kind === "added" ? palette.success : palette.danger}>
                {line.kind === "added" ? "+" : "-"}
              </Text>{" "}
            </Text>
          </Box>
          <Box
            flexGrow={1}
            flexShrink={1}
            backgroundColor={line.kind === "added" ? palette.diffAddBg : palette.diffRemoveBg}
          >
            <Text>{line.text || " "}</Text>
          </Box>
        </Box>
      ))}
      {hidden > 0 ? (
        <Box paddingLeft={5}>
          <Text color={palette.faint}>
            {`… ${hidden} more changed line${hidden === 1 ? "" : "s"} (ctrl+o to expand, ctrl+t to inspect)`}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

export function PlanView({
  entries,
  frame = 0,
}: {
  entries: PlanEntryView[];
  frame?: number;
}) {
  const completed = entries.filter((entry) => entry.status === "completed").length;
  return (
    <Box flexDirection="column" paddingLeft={1}>
      <Text>
        <Text color={palette.accent}>Tasks</Text>
        <Text color={palette.muted}>{` (${completed}/${entries.length})`}</Text>
      </Text>
      {entries.map((entry, index) => (
        <Box key={index}>
          <Box flexShrink={0}>
            {entry.status === "completed" ? (
              <Text color={palette.success}>[✓] </Text>
            ) : entry.status === "in_progress" ? (
              <Text color={palette.warning}>
                {`[${WORKING_FRAMES[frame % WORKING_FRAMES.length]}] `}
              </Text>
            ) : (
              <Text color={palette.faint}>[ ] </Text>
            )}
          </Box>
          <Box flexGrow={1} flexShrink={1}>
            <Text color={entry.status === "in_progress" ? palette.primary : palette.muted}>
              {entry.content}
            </Text>
          </Box>
        </Box>
      ))}
    </Box>
  );
}
