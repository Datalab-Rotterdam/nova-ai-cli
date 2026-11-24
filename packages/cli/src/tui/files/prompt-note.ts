/**
 * Context the CLI adds to a prompt (mentioned files, `!` shell runs) goes in a
 * trailing note: the model sees it, the transcript and resumed sessions don't.
 * Every client's note is hidden: `<nova-desktop-note>` from the desktop app,
 * `<nova-command-note>` from the agent's /init, /review, … — the desktop app
 * uses the same pattern. An unclosed note is a title cut off in the middle.
 */
const NOTE_RE = /\s*<(nova-[\w-]+-note)>[\s\S]*?(?:<\/\1>|$)/g;

export function withPromptNote(text: string, notes: string[]): string {
  return notes.length ? `${text}\n\n<nova-cli-note>\n${notes.join("\n\n")}\n</nova-cli-note>` : text;
}

export function stripPromptNote(text: string): string {
  return text.replace(NOTE_RE, "").trimEnd();
}
