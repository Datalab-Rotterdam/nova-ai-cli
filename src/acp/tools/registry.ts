import type * as acp from "@agentclientprotocol/sdk";
import { readFileTool } from "./read-file.js";
import { runCommandTool } from "./run-command.js";
import type { ToolDefinition } from "./types.js";
import { writeFileTool } from "./write-file.js";

const TOOLS: ToolDefinition[] = [readFileTool, writeFileTool, runCommandTool];

export function availableTools(caps: acp.ClientCapabilities | undefined): ToolDefinition[] {
  return TOOLS.filter((tool) => tool.requiredCapability(caps));
}

export function findTool(name: string): ToolDefinition | undefined {
  return TOOLS.find((tool) => tool.name === name);
}
