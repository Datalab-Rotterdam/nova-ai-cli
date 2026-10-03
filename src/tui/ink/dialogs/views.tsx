import { Box, Text, useInput, usePaste } from "ink";
import stringWidth from "string-width";
import { useMemo, useState, type ReactNode } from "react";
import { OTHER_OPTION_ID } from "../../../core/user-questions.js";
import type { PermissionRequestView } from "../../state/types.js";
import { formatToolCallDetails, sanitizeTerminalText, toolCallSummary } from "../format.js";
import { palette } from "../theme.js";
import { StatusIcon } from "../components/transcript.js";
import {
  permissionKey,
  type DialogResult,
  type QuestionState,
  type ScrollState,
  type SelectionState,
  type ToolInspectorState,
  windowStart,
} from "./state.js";

type Keyed = { isActive?: boolean };

/** Re-renders after every key the dialog used. */
function useDialogInput(
  handle: (input: string, key: Parameters<Parameters<typeof useInput>[0]>[1]) => DialogResult,
  isActive: boolean,
): void {
  const [, setTick] = useState(0);
  useInput(
    (input, key) => {
      if (handle(input, key) === "changed") setTick((tick) => tick + 1);
    },
    { isActive },
  );
}

export function Frame({ title, children, footer }: { title: string; children: ReactNode; footer?: string }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={palette.primary} paddingX={1}>
      <Text color={palette.primary} wrap="truncate-end">
        {title}
      </Text>
      {children}
      {footer ? (
        <Text color={palette.faint} wrap="truncate-end">
          {footer}
        </Text>
      ) : null}
    </Box>
  );
}

export function SelectionDialog({
  title,
  state,
  height,
  isActive = true,
}: { title: string; state: SelectionState; height: number } & Keyed) {
  const rows = Math.max(1, Math.min(state.items.length, height - 5));
  useDialogInput((input, key) => state.handleKey(input, key, rows), isActive);
  const start = windowStart(state.selected, state.items.length, rows);
  const visible = state.items.slice(start, start + rows);
  const leadingWidth = Math.min(
    14,
    Math.max(0, ...state.items.map((item) => (item.columns ? stringWidth(item.columns.leading) : 0))),
  );
  return (
    <Frame
      title={title}
      footer={`${state.selected + 1}/${state.items.length} · ↑↓ PgUp/PgDn navigate · Enter select · Esc close`}
    >
      {visible.map((item, index) => {
        const selected = start + index === state.selected;
        const marker = <Text color={palette.primary}>{selected ? "> " : "  "}</Text>;
        if (item.columns) {
          return (
            <Box key={item.value}>
              {marker}
              <Box width={leadingWidth} flexShrink={0}>
                <Text bold={selected} wrap="truncate-end">
                  {item.columns.leading}
                </Text>
              </Box>
              <Box flexGrow={1} flexShrink={1} marginLeft={2}>
                <Text bold={selected} wrap="truncate-end">
                  {item.columns.main.replace(/\s+/g, " ").trim()}
                </Text>
              </Box>
              <Box flexShrink={0} marginLeft={2}>
                <Text color={palette.muted}>{item.columns.trailing}</Text>
              </Box>
            </Box>
          );
        }
        return (
          <Box key={item.value}>
            {marker}
            <Box flexShrink={0} minWidth={Math.min(32, stringWidth(item.label))}>
              <Text bold={selected} wrap="truncate-end">
                {item.label || item.value}
              </Text>
            </Box>
            {item.description ? (
              <Box flexGrow={1} flexShrink={1} marginLeft={2}>
                <Text color={palette.muted} wrap="truncate-end">
                  {item.description.replace(/[\r\n]+/g, " ").trim()}
                </Text>
              </Box>
            ) : null}
          </Box>
        );
      })}
    </Frame>
  );
}

export function ScrollPanel({
  title,
  content,
  height,
  width,
  state,
  isActive = true,
}: { title: string; content: string; height: number; width: number; state: ScrollState } & Keyed) {
  const bodyRows = Math.max(1, height - 4);
  useDialogInput((input, key) => state.handleKey(input, key, bodyRows), isActive);
  const wrapWidth = Math.max(1, width - 4);
  const lines = useMemo(
    () => wrapPlain(sanitizeTerminalText(content.replace(/\r\n?/g, "\n").replace(/\t/g, "    ")) || "(no output)", wrapWidth),
    [content, wrapWidth],
  );
  const offset = state.clamp(lines.length, bodyRows);
  const visible = lines.slice(offset, offset + bodyRows);
  return (
    <Frame
      title={title}
      footer={`${offset + 1}-${offset + visible.length} of ${lines.length} · ↑↓ PgUp/PgDn Home/End · Esc close`}
    >
      <Text>{visible.join("\n")}</Text>
    </Frame>
  );
}

export function ToolInspector({
  state,
  height,
  width,
  isActive = true,
}: { state: ToolInspectorState; height: number; width: number } & Keyed) {
  const calls = state.calls();
  const listRows = state.expanded
    ? Math.min(calls.length, Math.max(1, Math.min(6, height - 8)))
    : Math.min(calls.length, Math.max(1, height - 4));
  const detailRows = Math.max(1, height - listRows - 5);
  useDialogInput(
    (input, key) => state.handleKey(input, key, state.expanded ? detailRows : listRows),
    isActive,
  );
  if (calls.length === 0) {
    return (
      <Frame title="Tool calls" footer="Esc close">
        <Text color={palette.faint}>No tool calls yet.</Text>
      </Frame>
    );
  }
  const start = windowStart(state.selected, calls.length, listRows);
  const selected = calls[state.selected]!;
  let details: string[] = [];
  let detailStart = 0;
  if (state.expanded) {
    const all = wrapPlain(formatToolCallDetails(selected), Math.max(1, width - 6));
    detailStart = Math.max(0, Math.min(state.detailOffset, all.length - detailRows));
    state.detailOffset = detailStart;
    details = all.slice(detailStart, detailStart + detailRows);
    details.push(
      `(${detailStart + 1}-${detailStart + details.length} of ${all.length})`,
    );
  }
  return (
    <Frame
      title={`Tool calls (${calls.length})`}
      footer={`${state.selected + 1}/${calls.length} · ↑↓ select · Enter/Space/←→ details · Esc close`}
    >
      {calls.slice(start, start + listRows).map((call, index) => {
        const isSelected = start + index === state.selected;
        const summary = toolCallSummary(call);
        return (
          <Box key={call.toolCallId}>
            <Text color={palette.primary}>{isSelected ? "> " : "  "}</Text>
            <Box flexGrow={1} flexShrink={1}>
              <Text bold={isSelected} wrap="truncate-end">
                {isSelected && state.expanded ? "v " : "> "}
                <StatusIcon status={call.status} /> {call.name}
                {summary ? `: ${summary}` : ""}
              </Text>
            </Box>
            {width >= 48 ? (
              <Box flexShrink={0} marginLeft={2}>
                <Text color={palette.muted}>
                  {`${call.status} | ${call.kind}${call.mutating ? " | changes" : ""}`}
                </Text>
              </Box>
            ) : null}
          </Box>
        );
      })}
      {state.expanded ? (
        <Box paddingLeft={2} flexDirection="column">
          <Text color={palette.muted}>{details.slice(0, -1).join("\n")}</Text>
          <Text color={palette.faint}>{details.at(-1)}</Text>
        </Box>
      ) : null}
    </Frame>
  );
}

export function QuestionDialog({
  state,
  isActive = true,
}: { state: QuestionState } & Keyed) {
  const [, setTick] = useState(0);
  useInput(
    (input, key) => {
      if (state.handleKey(input, key) === "changed") setTick((tick) => tick + 1);
    },
    { isActive },
  );
  usePaste(
    (text) => {
      if (state.paste(text) === "changed") setTick((tick) => tick + 1);
    },
    { isActive },
  );
  const question = state.question;
  if (!question) return null;
  const total = state.pending.request.questions.length;
  const heading = (
    <>
      <Text color={palette.faint}>
        {`Question ${state.questionIndex + 1}/${total} · ${
          state.customMode
            ? "own answer"
            : question.type === "multiple"
              ? "select one or more"
              : "select one"
        }`}
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Text color={palette.primary}>{question.question}</Text>
        {question.description ? <Text color={palette.muted}>{question.description}</Text> : null}
      </Box>
    </>
  );

  if (state.customMode) {
    const { col } = state.customInput.cursor;
    const text = state.customInput.text;
    return (
      <Frame title={state.pending.request.message} footer="Enter submit · Esc back to choices">
        {heading}
        <Box marginTop={1} flexDirection="column">
          <Text color={palette.primary}>Your answer</Text>
          <Text>
            {"> "}
            {text.slice(0, col)}
            <Text inverse>{text.slice(col, col + 1) || " "}</Text>
            {text.slice(col + 1)}
          </Text>
          {state.validationMessage ? <Text color={palette.danger}>{state.validationMessage}</Text> : null}
        </Box>
      </Frame>
    );
  }

  const otherIndex = question.options.length;
  const otherAnswer = state.customAnswer(question.id);
  return (
    <Frame
      title={state.pending.request.message}
      footer={
        question.type === "multiple"
          ? "↑↓ navigate · Space toggle · Enter continue · Esc cancel"
          : "↑↓ navigate · Enter select · Esc cancel"
      }
    >
      {heading}
      <Box marginTop={1} flexDirection="column">
        {question.options.map((option, index) => {
          const cursor = index === state.selected;
          const mark =
            question.type === "multiple"
              ? state.isSelected(question.id, option.id)
                ? "[x]"
                : "[ ]"
              : cursor
                ? "(o)"
                : "( )";
          return (
            <Box key={option.id} flexDirection="column">
              <Text wrap="truncate-end">
                <Text color={palette.primary}>{cursor ? ">" : " "}</Text>{" "}
                <Text color={mark === "[x]" ? palette.success : cursor ? palette.primary : undefined}>
                  {mark}
                </Text>{" "}
                {option.label}
                {option.recommended ? <Text color={palette.success}> (recommended)</Text> : null}
              </Text>
              {option.description ? (
                <Box paddingLeft={6}>
                  <Text color={palette.muted} wrap="truncate-end">
                    {option.description.replace(/[\r\n]+/g, " ")}
                  </Text>
                </Box>
              ) : null}
            </Box>
          );
        })}
        <Text wrap="truncate-end">
          <Text color={palette.primary}>{state.selected === otherIndex ? ">" : " "}</Text>{" "}
          {state.isSelected(question.id, OTHER_OPTION_ID) ? <Text color={palette.success}>[x]</Text> : "[ ]"}{" "}
          {otherAnswer ? `Other: ${otherAnswer}` : "Other... (write your own answer)"}
        </Text>
        {state.validationMessage ? (
          <Box marginTop={1}>
            <Text color={palette.danger}>{state.validationMessage}</Text>
          </Box>
        ) : null}
      </Box>
    </Frame>
  );
}

export function PermissionDialog({
  request,
  onClose,
  isActive = true,
}: { request: PermissionRequestView; onClose: () => void } & Keyed) {
  useInput(
    (input, key) => {
      if (permissionKey(request, input, key) === "closed") onClose();
    },
    { isActive },
  );
  const args = JSON.stringify(request.args, null, 2).split("\n");
  const shown = args.slice(0, 12);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={palette.warning} paddingX={1}>
      <Text color={palette.warning} bold>
        {request.title ?? `Permission requested: ${request.toolName}`}
      </Text>
      <Text color={palette.muted}>{`${request.toolName} · ${request.kind} tool`}</Text>
      <Box marginTop={1} paddingLeft={1} flexDirection="column">
        <Text>{shown.join("\n")}</Text>
        {args.length > shown.length ? (
          <Text color={palette.faint}>{`… ${args.length - shown.length} more lines`}</Text>
        ) : null}
      </Box>
      <Box marginTop={1}>
        <Text>
          <Text color={palette.primary}>[a]</Text> once  <Text color={palette.primary}>[s]</Text> this session
          {"  "}
          <Text color={palette.primary}>[w]</Text> always  <Text color={palette.danger}>[d]</Text> deny
        </Text>
      </Box>
    </Box>
  );
}

/** Wraps plain text (no ANSI) into rows of at most `width` columns. */
export function wrapPlain(text: string, width: number): string[] {
  const rows: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line === "") {
      rows.push("");
      continue;
    }
    let current = "";
    let currentWidth = 0;
    for (const character of line) {
      const characterWidth = stringWidth(character);
      if (currentWidth + characterWidth > width && current) {
        rows.push(current);
        current = "";
        currentWidth = 0;
      }
      current += character;
      currentWidth += characterWidth;
    }
    rows.push(current);
  }
  return rows;
}
