import {
  Editor,
  Key,
  matchesKey,
  type EditorOptions,
  type EditorTheme,
  type TUI,
} from "@earendil-works/pi-tui";
import {
  DraftPasteAttachments,
  isLargeClipboardPaste,
  normalizeClipboardPaste,
  type PromptPasteAttachment,
} from "../files/prompt-pastes.js";
import { colors } from "./theme.js";

export type QueuedEditorItem = { id: string; text: string };

const BRACKETED_PASTE_START = "\u001b[200~";
const BRACKETED_PASTE_END = "\u001b[201~";

/** Multiline editor with a stable shell-style prompt and Pi's hardware cursor marker. */
export class PromptEditor extends Editor {
  private queuedMessages: (() => QueuedEditorItem[]) | null = null;
  private editingQueueId: string | null = null;
  private queueDraft = "";
  private bracketedPasteBuffer: string | null = null;
  private readonly draftPastes = new DraftPasteAttachments();

  onQueuedMessageEditStart?: (id: string) => void;
  onQueuedMessageEditFinish?: (id: string, text: string) => void;

  constructor(tui: TUI, theme: EditorTheme, options: EditorOptions = {}) {
    super(tui, theme, {
      ...options,
      paddingX: Math.max(2, options.paddingX ?? 2),
    });
  }

  setQueuedMessageProvider(provider: () => QueuedEditorItem[]): void {
    this.queuedMessages = provider;
  }

  editingQueuedMessage(): string | null {
    return this.editingQueueId;
  }

  referencedPastes(text: string): PromptPasteAttachment[] {
    return this.draftPastes.referencedBy(text);
  }

  clearPastes(): void {
    this.draftPastes.clear();
  }

  override handleInput(data: string): void {
    if (this.captureBracketedPaste(data)) return;
    if (!this.isShowingAutocomplete()) {
      if (matchesKey(data, Key.enter) && this.editingQueueId) {
        this.finishQueueEdit();
        return;
      }
      if (
        matchesKey(data, Key.up) &&
        (this.editingQueueId !== null || this.getText().length === 0) &&
        this.navigateQueuedMessages(-1)
      ) {
        return;
      }
      if (
        matchesKey(data, Key.down) &&
        this.editingQueueId !== null &&
        this.navigateQueuedMessages(1)
      ) {
        return;
      }
    }
    super.handleInput(data);
  }

  override render(width: number): string[] {
    const rows = super.render(width);
    const firstInputRow = rows[1];
    if (firstInputRow?.startsWith("  ")) {
      rows[1] = `${colors.primary(">")} ${firstInputRow.slice(2)}`;
    }
    return rows;
  }

  private captureBracketedPaste(data: string): boolean {
    if (this.bracketedPasteBuffer !== null) {
      this.bracketedPasteBuffer += data;
      this.finishBracketedPasteIfComplete();
      return true;
    }

    const startIndex = data.indexOf(BRACKETED_PASTE_START);
    if (startIndex < 0) return false;
    if (startIndex > 0) super.handleInput(data.slice(0, startIndex));
    this.bracketedPasteBuffer = data.slice(
      startIndex + BRACKETED_PASTE_START.length,
    );
    this.finishBracketedPasteIfComplete();
    return true;
  }

  private finishBracketedPasteIfComplete(): void {
    const buffered = this.bracketedPasteBuffer;
    if (buffered === null) return;
    const endIndex = buffered.indexOf(BRACKETED_PASTE_END);
    if (endIndex < 0) return;

    const pastedText = buffered.slice(0, endIndex);
    const remaining = buffered.slice(endIndex + BRACKETED_PASTE_END.length);
    this.bracketedPasteBuffer = null;
    const normalized = normalizeClipboardPaste(pastedText);

    if (normalized && isLargeClipboardPaste(normalized)) {
      const paste = this.draftPastes.add(normalized);
      this.insertTextAtCursor(paste.marker);
    } else if (pastedText) {
      // Retain the upstream editor's handling for ordinary clipboard pastes.
      super.handleInput(
        `${BRACKETED_PASTE_START}${pastedText}${BRACKETED_PASTE_END}`,
      );
    }

    if (remaining) this.handleInput(remaining);
  }

  private navigateQueuedMessages(direction: -1 | 1): boolean {
    const items = this.queuedMessages?.() ?? [];
    if (items.length === 0) {
      if (this.editingQueueId) this.finishQueueEdit();
      return false;
    }

    if (!this.editingQueueId) {
      if (direction > 0) return false;
      this.queueDraft = this.getText();
      this.selectQueuedMessage(items.at(-1)!);
      return true;
    }

    const currentIndex = items.findIndex(
      (item) => item.id === this.editingQueueId,
    );
    if (currentIndex < 0) {
      this.editingQueueId = null;
      this.setText(this.queueDraft);
      return true;
    }

    const nextIndex = currentIndex + direction;
    if (nextIndex < 0) return true;
    if (nextIndex >= items.length) {
      this.finishQueueEdit();
      return true;
    }

    const next = items[nextIndex]!;
    const previousId = this.editingQueueId;
    const previousText = this.getText();
    this.editingQueueId = null;
    this.onQueuedMessageEditFinish?.(previousId, previousText);
    this.selectQueuedMessage(next);
    return true;
  }

  private selectQueuedMessage(item: QueuedEditorItem): void {
    this.editingQueueId = item.id;
    this.onQueuedMessageEditStart?.(item.id);
    this.setText(item.text);
  }

  private finishQueueEdit(): void {
    const id = this.editingQueueId;
    if (!id) return;
    const text = this.getText();
    const draft = this.queueDraft;
    this.editingQueueId = null;
    this.queueDraft = "";
    this.onQueuedMessageEditFinish?.(id, text);
    this.setText(draft);
  }
}
