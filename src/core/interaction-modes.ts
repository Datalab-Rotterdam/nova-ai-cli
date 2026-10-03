export const INTERACTION_MODES = ["agent", "ask", "plan"] as const;

export type InteractionMode = (typeof INTERACTION_MODES)[number];

export function isInteractionMode(value: unknown): value is InteractionMode {
  return (
    typeof value === "string" &&
    INTERACTION_MODES.includes(value as InteractionMode)
  );
}

/**
 * Plan mode investigates and plans: it may read the workspace, ask the user
 * and keep the task list, but nothing that changes files, runs commands or
 * reaches an MCP server. Ask mode gets no tools; agent mode gets them all.
 */
export const PLAN_MODE_TOOLS: ReadonlySet<string> = new Set([
  "read_file",
  "list_directory",
  "search_text",
  "memory_read",
  "load_skill",
  "ask_user",
  "update_plan",
]);
