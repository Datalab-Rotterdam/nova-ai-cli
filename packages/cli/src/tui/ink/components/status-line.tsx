import { Box, Text } from "ink";
import type { UIState } from "../../state/types.js";
import type { McpCounts } from "../controller.js";
import { formatTokenCount } from "../format.js";
import { palette } from "../theme.js";

export function StatusLine({
  ui,
  model,
  mcp,
}: {
  ui: UIState;
  model: string;
  mcp: McpCounts;
}) {
  const separator = <Text color={palette.faint}> | </Text>;
  const usage = ui.contextUsage
    ? `ctx:${formatTokenCount(ui.contextUsage.totalTokens)}${ui.contextUsage.contextWindow ? `/${formatTokenCount(ui.contextUsage.contextWindow)}` : ""}`
    : null;
  return (
    <Box flexDirection="column">
      {ui.updateAvailable ? (
        <Text color={palette.warning}>
          {`Update ${ui.updateAvailable.latestVersion} available (current ${ui.updateAvailable.currentVersion}). ${
            ui.updateAvailable.installable ? "Type /update to install it." : `Run: ${ui.updateAvailable.command}`
          }`}
        </Text>
      ) : null}
      {ui.statusLine ? <Text color={palette.muted}>{ui.statusLine}</Text> : null}
      <Text wrap="truncate-end">
        <Text color={palette.muted}>{model}</Text>
        {separator}
        {ui.interactionMode}
        {separator}
        {ui.permissionMode}
        {separator}
        {ui.busy ? <Text color={palette.warning}>working</Text> : <Text color={palette.success}>ready</Text>}
        {usage ? (
          <>
            {separator}
            {usage}
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
        {mcp.skills ? (
          <>
            {separator}
            {`skills:${mcp.skills}`}
          </>
        ) : null}
      </Text>
    </Box>
  );
}
