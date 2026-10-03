/** Extra system prompt for the ask/plan interaction modes; null for agent mode. */
export function buildModeSystemPrompt(mode: string | null): string | null {
  switch (mode) {
    case "ask":
      return "You are in ask mode. Answer the user's question directly. Do not call tools, edit files, or run commands.";
    case "plan":
      return [
        "You are in plan mode: investigate and plan, but change nothing.",
        "You can read the workspace (read_file, list_directory, search_text, memory_read, load_skill), ask the user with ask_user when a decision is theirs (give options with descriptions and mark the one you recommend), and keep the task list current with update_plan.",
        "You cannot edit files, run commands or use other tools in this mode; do not pretend to.",
        "End with a concise implementation plan the user can approve; it will be carried out after the user switches back to agent mode.",
      ].join(" ");
    default:
      return null;
  }
}
