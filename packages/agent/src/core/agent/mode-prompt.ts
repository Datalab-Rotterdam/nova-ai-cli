import { findAgentFile } from "../agent-files.js";

/** Extra system prompt for the ask/plan modes and agent files (their body, read from `cwd`); null for agent mode. */
export function buildModeSystemPrompt(mode: string | null, cwd?: string): string | null {
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
    case "autopilot":
      return [
        "You are in autopilot mode. Work autonomously until the task is completely done.",
        "Do not stop to ask for confirmation or clarification: when something is ambiguous, pick the most reasonable option, say which one you chose and continue (ask_user is answered for you).",
        "Plan the work with update_plan, then carry it out step by step, running the relevant tests or build as you go.",
        "You still work within the user's permissions: a tool call the user has to approve waits for their decision; if one is rejected, take another route.",
        "Finish with a short summary of what changed, the decisions you made on your own, and anything left to do.",
      ].join(" ");
    case "agent":
    case null:
      return null;
    default:
      return (cwd && findAgentFile(cwd, mode)?.prompt) || null;
  }
}
