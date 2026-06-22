import type { ToolDefinition } from "./types.js";

export function buildToolsSystemPrompt(tools: ToolDefinition[], cwd: string): string | null {
  if (tools.length === 0) return null;

  const toolList = tools.map((tool) => `- ${tool.description}`).join("\n");

  return [
    `The user's workspace root is: ${cwd}`,
    "Always use absolute paths rooted there (e.g. resolve a file named X to the corresponding path under that root). Never guess or invent a path like /home/user/... — use the workspace root given above.",
    "You can use tools to read/write files or run shell commands in the user's workspace.",
    "To use a tool, emit exactly this fenced block and nothing else after it in your turn:",
    "```tool_call",
    '{"name": "<tool name>", "args": { ... }}',
    "```",
    "STRICT rules for this JSON:",
    "- All tool arguments go INSIDE the \"args\" object. Never put them at the top level next to \"name\".",
    "- Include every argument the tool needs, exactly as named below. Do not omit \"path\", \"content\", or \"command\".",
    "- Example for write_file: ```tool_call",
    '{"name": "write_file", "args": {"path": "' + cwd.replace(/\\/g, "\\\\") + '/example.txt", "content": "file contents here"}}',
    "```",
    "- One tool call per turn. After the result comes back, continue or call another tool.",
    "Wait for the tool's result before continuing. Available tools:",
    toolList,
  ].join("\n");
}
