/** Extra system prompt for the ask/plan interaction modes; null for agent mode. */
export function buildModeSystemPrompt(mode: string | null): string | null {
  switch (mode) {
    case "ask":
      return "You are in ask mode. Answer the user's question directly. Do not call tools, edit files, or run commands.";
    case "plan":
      return "You are in plan mode. Produce a concise implementation plan or technical approach. Do not call tools, edit files, or run commands.";
    default:
      return null;
  }
}
