export const INTERACTION_MODES = ["agent", "ask", "plan", "autopilot"] as const;

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
  "find_files",
  "search_text",
  "memory_read",
  "load_skill",
  "ask_user",
  "update_plan",
]);

/** Tool rounds per turn in autopilot, where the usual limit is lifted (the VS Code extension's value). */
export const AUTOPILOT_MAX_TOOL_ROUNDS = 1_000;

/** What ask_user answers in autopilot: nobody is there to answer. */
export const AUTOPILOT_ANSWER =
  "Autopilot is on and no user is available to answer. Choose the most reasonable option yourself, mention the choice in your summary and continue.";
