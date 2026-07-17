import { Editor, type EditorOptions, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import { colors } from "./theme.js";

/** Multiline editor with a stable shell-style prompt and Pi's hardware cursor marker. */
export class PromptEditor extends Editor {
  constructor(tui: TUI, theme: EditorTheme, options: EditorOptions = {}) {
    super(tui, theme, { ...options, paddingX: Math.max(2, options.paddingX ?? 2) });
  }

  override render(width: number): string[] {
    const rows = super.render(width);
    const firstInputRow = rows[1];
    if (firstInputRow?.startsWith("  ")) {
      rows[1] = `${colors.primary(">")} ${firstInputRow.slice(2)}`;
    }
    return rows;
  }
}
