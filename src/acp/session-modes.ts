import type * as acp from "@agentclientprotocol/sdk";
import type { InteractionMode } from "../core/interaction-modes.js";

const AVAILABLE_MODES: acp.SessionMode[] = [
  {
    id: "agent",
    name: "Agent",
    description: "Inspect the workspace, call tools, and make approved changes.",
  },
  {
    id: "ask",
    name: "Ask",
    description: "Answer directly without calling tools or changing files.",
  },
  {
    id: "plan",
    name: "Plan",
    description: "Develop an implementation plan without calling tools or changing files.",
  },
];

export function sessionModeState(
  currentModeId: InteractionMode,
): acp.SessionModeState {
  return {
    currentModeId,
    availableModes: AVAILABLE_MODES.map((mode) => ({ ...mode })),
  };
}
