import type { ToolDefinition } from "./types.js";

export const editFileTool: ToolDefinition = {
  name: "edit_file",
  description:
    'edit_file: {"path": "<absolute path>", "old_string": "<exact text to replace>", "new_string": "<replacement text>"} — replace one exact occurrence of old_string with new_string in a text file. Fails if old_string is not found exactly once.',
  requiredCapability: (caps) => !!caps?.fs?.readTextFile && !!caps?.fs?.writeTextFile,
  mutating: true,
  kind: "edit",
  async execute({ host, signal }, args) {
    const path = typeof args.path === "string" ? args.path : "";
    const oldString = typeof args.old_string === "string" ? args.old_string : "";
    const newString = typeof args.new_string === "string" ? args.new_string : "";
    if (!path) return { error: "edit_file requires a 'path' argument." };
    if (!oldString) return { error: "edit_file requires a non-empty 'old_string' argument." };

    let content: string;
    try {
      content = await host.readTextFile(path, signal);
    } catch (err) {
      return { error: err instanceof Error ? err.message : "Failed to read file." };
    }

    const occurrences = content.split(oldString).length - 1;
    if (occurrences === 0) return { error: `old_string not found in ${path}.` };
    if (occurrences > 1) return { error: `old_string matches ${occurrences} locations in ${path}; it must match exactly once.` };

    const newContent = content.replace(oldString, newString);
    try {
      await host.writeTextFile(path, newContent, signal);
    } catch (err) {
      return { error: err instanceof Error ? err.message : "Failed to write file." };
    }

    return {
      output: `Edited ${path}.`,
      diff: { path, oldText: content, newText: newContent },
    };
  },
};
