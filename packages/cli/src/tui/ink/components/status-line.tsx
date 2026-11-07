import { Box, Text } from "ink";
import type { UIState } from "../../state/types.js";
import type { McpCounts } from "../controller.js";
import { formatCost, formatTokenCount } from "../format.js";
import { palette } from "../theme.js";

/** Labels are shared with mouse hit testing, including their visible shortcuts. */
export function statusActions(model: string, ui: UIState, mcp: McpCounts) {
  return [
    { id: "model", label: `Model: ${model}` },
    { id: "mode", label: `Mode: ${ui.interactionMode}` },
    { id: "permissions", label: `Approvals: ${ui.permissionMode}` },
    ...(mcp.skills ? [{ id: "skills", label: `Skills: ${mcp.skills}` }] : []),
  ];
}

/** Two single-line notices fit the reserved space above the prompt. */
export function StatusNotices({ ui }: { ui: UIState }) {
  return (
    <Box flexDirection="column" paddingLeft={1}>
      {ui.updateAvailable ? (
        <Text color={palette.warning} wrap="truncate-end">
          {`Update ${ui.updateAvailable.latestVersion} available (current ${ui.updateAvailable.currentVersion}). ${
            ui.updateAvailable.installable ? "Type /update to install it." : `Run: ${ui.updateAvailable.command}`
          }`}
        </Text>
      ) : null}
      {ui.statusLine ? <Text color={palette.muted} wrap="truncate-end">{ui.statusLine}</Text> : null}
    </Box>
  );
}

export function StatusLine({
  ui,
  model,
  effort = null,
  mcp,
  scroll = 0,
}: {
  ui: UIState;
  model: string;
  /** Thinking level name for a thinking model with levels. */
  effort?: string | null;
  mcp: McpCounts;
  /** Transcript rows scrolled up from the newest. */
  scroll?: number;
}) {
  const separator = <Text color={palette.faint}> | </Text>;
  const usage = ui.contextUsage;
  const fraction = usage && usage.contextWindow && usage.contextWindow > 0
    ? Math.min(1, Math.max(0, usage.totalTokens / usage.contextWindow))
    : null;
  const filled = fraction === null ? 0 : Math.round(fraction * 10);
  return (
    <Box flexDirection="column" paddingLeft={1} height={2}>
      <Text wrap="truncate-end">
        {scroll ? <><Text color={palette.warning}>{`↑${scroll} lines · PgDn/Esc`}</Text>{separator}</> : null}
        {statusActions(model, ui, mcp).map((item, index) => <Text key={item.id}>{index ? separator : null}<Text color={palette.primary}>{item.label}</Text></Text>)}
        {effort ? <Text color={palette.muted}>{` · thinking ${effort.toLowerCase()}`}</Text> : null}
        {separator}
        {ui.busy ? <Text color={palette.warning}>Working</Text> : <Text color={palette.success}>Ready for a prompt</Text>}
        {ui.usageTotals?.cost !== undefined ? (
          <>
            {separator}
            {`≈ ${formatCost(ui.usageTotals.cost, ui.usageTotals.currency)}`}
          </>
        ) : null}
        {ui.queuedCount ? (
          <>
            {separator}
            {`queued:${ui.queuedCount}`}
          </>
        ) : null}
        {mcp.configured ? (
          <>
            {separator}
            {`mcp:${mcp.connected}/${mcp.configured}`}
            {mcp.failed ? <Text color={palette.danger}>{` !${mcp.failed}`}</Text> : null}
          </>
        ) : null}
      </Text>
      {usage ? (
        <Text wrap="truncate-end">
          <Text color={palette.muted}>Context </Text>
          {fraction !== null ? (
            <>
              <Text color={fraction >= 0.9 ? palette.danger : fraction >= 0.7 ? palette.warning : palette.primary}>
                {"■".repeat(filled)}
              </Text>
              <Text color={palette.faint}>{"·".repeat(10 - filled)}</Text>
              <Text color={palette.muted}>{` ${Math.round(fraction * 100)}%  `}</Text>
            </>
          ) : null}
          <Text color={palette.muted}>
            {`${formatTokenCount(usage.totalTokens)}${usage.contextWindow ? ` / ${formatTokenCount(usage.contextWindow)}` : ""} tokens`}
          </Text>
        </Text>
      ) : <Text> </Text>}
    </Box>
  );
}
