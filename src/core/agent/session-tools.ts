import type * as acp from "@agentclientprotocol/sdk";
import type { InteractionMode } from "../interaction-modes.js";
import { interactionModeAllowsTools } from "../interaction-modes.js";
import {
  createLoadMemoryTool,
  createSaveMemoryTool,
  discoverMemories,
} from "../memory.js";
import { createLoadSkillTool } from "../skills.js";
import { createEnterPlanModeTool } from "../tools/enter-plan-mode.js";
import { availableTools } from "../tools/registry.js";
import type { ToolDefinition } from "../tools/types.js";
import { createUpdatePlanTool } from "../tools/update-plan.js";
import type { Session } from "./session.js";

export function createMemoryTools(session: Session): ToolDefinition[] {
  return [
    createLoadMemoryTool(() => session.memory),
    createSaveMemoryTool(session.cwd, undefined, () => {
      session.memory = discoverMemories(session.cwd);
    }),
  ];
}

export type SessionToolOptions = {
  /**
   * Interaction mode gating the tools: ask/plan get none, agent mode also
   * gets enter_plan_mode. null skips gating entirely (background agents).
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
  if (!interactionModeAllowsTools(options.mode)) return [];
  return [
    ...(options.enterPlanMode
      ? [createEnterPlanModeTool(options.enterPlanMode)]
      : []),
    ...baseTools,
  ];
}
