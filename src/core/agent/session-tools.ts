import type * as acp from "@agentclientprotocol/sdk";
import type { InteractionMode } from "../interaction-modes.js";
import { PLAN_MODE_TOOLS } from "../interaction-modes.js";
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
   * enter_plan_mode. null skips gating entirely (background agents).
   */
  mode: InteractionMode | null;
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
  const baseTools = [
    ...(options.updatePlan ? [createUpdatePlanTool(options.updatePlan)] : []),
    ...availableTools(caps, session.environment, { background: true }),
    ...(session.skills.length ? [createLoadSkillTool(session.skills)] : []),
    ...createMemoryTools(session),
    ...session.mcpTools,
  ];
  if (options.mode === null) return baseTools;
  if (options.mode === "plan") {
    // By identity as well as name: an MCP server could name a tool read_file.
    return baseTools.filter(
      (tool) => PLAN_MODE_TOOLS.has(tool.name) && !session.mcpTools.includes(tool),
    );
  }
  if (options.mode !== "agent") return [];
  return [
    ...(options.enterPlanMode
      ? [createEnterPlanModeTool(options.enterPlanMode)]
      : []),
    ...baseTools,
  ];
}
