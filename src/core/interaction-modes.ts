export const INTERACTION_MODES = ["agent", "ask", "plan"] as const;

export type InteractionMode = (typeof INTERACTION_MODES)[number];

export function isInteractionMode(value: unknown): value is InteractionMode {
  return (
    typeof value === "string" &&
    INTERACTION_MODES.includes(value as InteractionMode)
  );
}

export function interactionModeAllowsTools(mode: InteractionMode): boolean {
  return mode === "agent";
}
