import type * as acp from "@agentclientprotocol/sdk";
import type { InteractionMode } from "../core/interaction-modes.js";
import type { PermissionMode } from "../core/policy/settings.js";

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
    description:
      "Read the workspace, ask questions and track tasks to develop a plan, without changing files or running commands.",
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

export const PERMISSION_MODE_CONFIG_ID = "permission_mode";

/** The permission mode as an ACP session config option. */
export function permissionModeOption(
  current: PermissionMode,
): acp.SessionConfigOption {
  return {
    id: PERMISSION_MODE_CONFIG_ID,
    name: "Permissions",
    description: "Which tool calls Nova may run without asking.",
    type: "select",
    currentValue: current,
    options: [
      { value: "default", name: "Ask", description: "Ask before every change or command." },
      { value: "acceptEdits", name: "Accept edits", description: "Apply file edits without asking; ask for commands." },
      { value: "bypassPermissions", name: "Bypass", description: "Run everything without asking (deny rules still apply). Not remembered." },
    ],
  };
}
