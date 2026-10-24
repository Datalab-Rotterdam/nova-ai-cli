import type * as acp from "@agentclientprotocol/sdk";
import type { InteractionMode } from "../interaction-modes.js";
import { PLAN_MODE_TOOLS } from "../interaction-modes.js";
import { findAgentFile, isAutopilot } from "../agent-files.js";
import { AUTOPILOT_ANSWER } from "../interaction-modes.js";
import {
  createMemoryReadTool,
  createMemoryWriteTool,
  loadMemory,
} from "../memory.js";
import { createLoadSkillTool } from "../skills.js";
import { createEnterPlanModeTool } from "../tools/enter-plan-mode.js";
import { availableTools } from "../tools/registry.js";
import type { ToolDefinition } from "../tools/types.js";
import { createUpdatePlanTool } from "../tools/update-plan.js";
import { createWebSearchTool } from "../tools/web-search.js";
import type { Session } from "./session.js";

export function createMemoryTools(session: Session): ToolDefinition[] {
  return [
    createMemoryReadTool(session.cwd, () => session.memory),
    createMemoryWriteTool(session.cwd, () => {
      session.memory = loadMemory(session.cwd);
    }),
  ];
}

export type SessionToolOptions = {
  /**
   * Interaction mode gating the tools: ask gets none, plan gets the
   * read-only PLAN_MODE_TOOLS, agent mode gets everything plus
   * enter_plan_mode, an agent file what its `tools` and `readOnly` allow.
   * null skips gating entirely (background agents).
   */
  mode: InteractionMode | string | null;
  updatePlan?: (entries: acp.PlanEntry[]) => void | Promise<void>;
  enterPlanMode?: () => void | Promise<void>;
};

/**
 * The one place that decides which tools a session offers the model, used
 * for foreground prompts, background agents and context-usage estimates so
 * the three can never drift apart.
 */
export function buildSessionTools(
  session: Session,
  caps: acp.ClientCapabilities | undefined,
  options: SessionToolOptions,
): ToolDefinition[] {
  const tools = modeTools(session, caps, options);
  if (!isAutopilot(session.cwd, options.mode)) return tools;
  // Nobody answers in autopilot: ask_user tells the model to pick the best default.
  return tools.map((tool) =>
    tool.name === "ask_user" ? { ...tool, execute: async () => ({ output: AUTOPILOT_ANSWER }) } : tool,
  );
}

function modeTools(
  session: Session,
  caps: acp.ClientCapabilities | undefined,
  options: SessionToolOptions,
): ToolDefinition[] {
  const baseTools = [
    ...(options.updatePlan ? [createUpdatePlanTool(options.updatePlan)] : []),
    ...availableTools(caps, session.environment, { background: true }),
    createWebSearchTool(() => session.settings.searxngUrl),
    ...(session.skills.length ? [createLoadSkillTool(session.skills)] : []),
    ...(session.settings.memory ? createMemoryTools(session) : []),
    ...session.mcpTools,
  ];
  if (options.mode === null) return baseTools;
  if (options.mode === "plan") {
    // By identity as well as name: an MCP server could name a tool read_file.
    return baseTools.filter(
      (tool) => PLAN_MODE_TOOLS.has(tool.name) && !session.mcpTools.includes(tool),
    );
  }
  if (options.mode === "autopilot") return baseTools;
  if (options.mode !== "agent") {
    const agent = options.mode === "ask" ? undefined : findAgentFile(session.cwd, options.mode);
    if (!agent) return [];
    return baseTools.filter((tool) => {
      if (agent.readOnly && tool.mutating) return false;
      if (!agent.tools) return true;
      // update_plan only shows the task list, so a narrowed agent keeps it.
      return session.mcpTools.includes(tool) ? agent.tools.includes("mcp") : agent.tools.includes(tool.name) || tool.name === "update_plan";
    });
  }
  return [
    ...(options.enterPlanMode
      ? [createEnterPlanModeTool(options.enterPlanMode)]
      : []),
    ...baseTools,
  ];
}
