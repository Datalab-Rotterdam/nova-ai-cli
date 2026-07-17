import type * as acp from "@agentclientprotocol/sdk";
import {
  killBackgroundJobTool,
  listBackgroundJobsTool,
  readBackgroundOutputTool,
  releaseBackgroundJobTool,
  startBackgroundAgentTool,
  startBackgroundCommandTool,
} from "./background.js";
import { askUserTool } from "./ask-user.js";
import { editFileTool } from "./edit-file.js";
import { inspectEnvironmentTool } from "./inspect-environment.js";
import { listDirectoryTool } from "./list-directory.js";
import { readFileTool } from "./read-file.js";
import { runPackageScriptTool } from "./run-package-script.js";
import { runCommandTool } from "./run-command.js";
import { searchTextTool } from "./search-text.js";
import type { ToolEnvironment } from "./environment.js";
import type { ToolDefinition } from "./types.js";
import { writeFileTool } from "./write-file.js";

const TOOLS: ToolDefinition[] = [
  askUserTool,
  inspectEnvironmentTool,
  listDirectoryTool,
  searchTextTool,
  readFileTool,
  writeFileTool,
  editFileTool,
  runCommandTool,
  runPackageScriptTool,
  startBackgroundCommandTool,
  startBackgroundAgentTool,
  listBackgroundJobsTool,
  readBackgroundOutputTool,
  killBackgroundJobTool,
  releaseBackgroundJobTool,
];

export function availableTools(
  caps: acp.ClientCapabilities | undefined,
  environment?: ToolEnvironment,
  options: { background?: boolean } = {},
): ToolDefinition[] {
  return TOOLS.filter((tool) => {
    if (tool.isAvailable)
      return tool.isAvailable({
        caps,
        environment,
        background: options.background,
      });
    return tool.requiredCapability?.(caps) ?? true;
  });
}

export function findTool(name: string): ToolDefinition | undefined {
  return TOOLS.find((tool) => tool.name === name);
}
