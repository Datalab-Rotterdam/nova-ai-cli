import type { Key } from "ink";
import {
  DraftPasteAttachments,
  isLargeClipboardPaste,
  normalizeClipboardPaste,
  type PromptPasteAttachment,
} from "../../files/prompt-pastes.js";
import {
  extractMentionPrefix,
  type AutocompleteItem,
  type WorkspaceAutocompleteProvider,
} from "../../files/workspace-autocomplete.js";
import { TextBuffer } from "./buffer.js";

export type QueuedEditorItem = { id: string; text: string };

export type AutocompleteView = {
  items: AutocompleteItem[];
  selected: number;
  prefix: string;
};

/** Every flag Ink can report; tests build keys with only the ones they need. */
export type KeyPress = Partial<Key>;

const MAX_HISTORY = 200;

/**
 * Everything the prompt does with keys, independent of React: editing,
 * history, queued-message editing, large-paste markers and autocomplete.
 * The view re-renders whenever `subscribe` listeners fire.
 */
export class PromptEditor {
  readonly buffer = new TextBuffer();
  private readonly history: string[] = [];
  /** -1: the draft; otherwise an index into history, newest last. */
  private historyIndex = -1;
  private historyDraft = "";
  private queuedMessages: (() => QueuedEditorItem[]) | null = null;
  private editingQueueId: string | null = null;
  private queueDraft = "";
  private readonly draftPastes = new DraftPasteAttachments();
  private autocompleteProvider: WorkspaceAutocompleteProvider | null = null;
  private autocompleteState: AutocompleteView | null = null;
  private autocompleteAbort: AbortController | null = null;
  private autocompleteRequest = 0;
  private readonly listeners = new Set<() => void>();
  private version = 0;
  private lastText = "";

  onSubmit?: (text: string) => void;
  onChange?: (text: string) => void;
  onQueuedMessageEditStart?: (id: string) => void;
  onQueuedMessageEditFinish?: (id: string, text: string) => void;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Changes whenever anything visible changed (for useSyncExternalStore). */
  getVersion = (): number => this.version;

  getText(): string {
    return this.buffer.text;
  }

  setText(text: string): void {
    this.buffer.setText(text);
    this.closeAutocomplete();
    this.changed();
  }

  insertTextAtCursor(text: string): void {
    this.buffer.insert(text);
    this.changed();
  }

  get autocomplete(): AutocompleteView | null {
    return this.autocompleteState;
  }

  setAutocompleteProvider(provider: WorkspaceAutocompleteProvider): void {
    this.autocompleteProvider = provider;
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

  addToHistory(text: string): void {
    const value = text.trim();
    if (!value || this.history.at(-1) === value) return;
    this.history.push(value);
    if (this.history.length > MAX_HISTORY) this.history.shift();
  }

  /** Text from the terminal's bracketed paste. */
  paste(text: string): void {
    const normalized = normalizeClipboardPaste(text);
    if (!normalized) return;
    if (isLargeClipboardPaste(normalized)) {
      this.buffer.insert(this.draftPastes.add(normalized).marker);
    } else {
      this.buffer.insert(normalized);
    }
    this.changed();
    this.refreshAutocomplete();
  }

  /** Returns false when the key is not the editor's (global shortcuts). */
  handleKey(input: string, key: KeyPress): boolean {
    // Fast typing (or input written by another program) can arrive as one
    // chunk; a carriage return inside it is still Enter. Real pastes come
    // through `paste` (bracketed paste) and keep their newlines.
    if (input.length > 1 && input.includes("\r") && !key.ctrl && !key.meta) {
      const parts = input.split(/\r\n?/);
      parts.forEach((part, index) => {
        if (part) this.handleKey(part, {});
        if (index < parts.length - 1) this.handleKey("\r", { return: true });
      });
      return true;
    }
    if (this.autocompleteState && this.handleAutocompleteKey(key))
      return true;

    if (key.return && (key.meta || key.shift)) return this.edit(() => this.buffer.newline());
    // Ctrl+J arrives as a bare line feed.
    if (input === "\n" && !key.return) return this.edit(() => this.buffer.newline());
    if (key.return) {
      this.submitOrContinue();
      return true;
    }
    if (key.tab && !key.shift) {
      this.refreshAutocomplete(true);
      return true;
    }
    if (key.upArrow) {
      if (
        (this.editingQueueId !== null || this.buffer.isEmpty) &&
        this.navigateQueuedMessages(-1)
      )
        return true;
      if (!this.buffer.up()) this.historyOlder();
      this.closeAutocomplete();
      this.changed();
      return true;
    }
    if (key.downArrow) {
      if (this.editingQueueId !== null && this.navigateQueuedMessages(1))
        return true;
      if (!this.buffer.down()) this.historyNewer();
      this.closeAutocomplete();
      this.changed();
      return true;
    }
    if (key.backspace) {
      return this.edit(() =>
        key.meta || key.ctrl
          ? this.buffer.deleteWordBackward()
          : this.buffer.backspace(),
      );
    }
    if (key.delete) return this.edit(() => this.buffer.deleteForward());
    if (key.leftArrow) {
      return this.move(() =>
        key.meta || key.ctrl ? this.buffer.wordLeft() : this.buffer.left(),
      );
    }
    if (key.rightArrow) {
      return this.move(() =>
        key.meta || key.ctrl ? this.buffer.wordRight() : this.buffer.right(),
      );
    }
    if (key.home) return this.move(() => this.buffer.lineStart());
    if (key.end) return this.move(() => this.buffer.lineEnd());

    if (key.ctrl) {
      switch (input) {
        case "a":
          return this.move(() => this.buffer.lineStart());
        case "e":
          return this.move(() => this.buffer.lineEnd());
        case "u":
          return this.edit(() => this.buffer.deleteToLineStart());
        case "w":
          return this.edit(() => this.buffer.deleteWordBackward());
        case "d":
          if (this.buffer.isEmpty) return false;
          return this.edit(() => this.buffer.deleteForward());
        default:
          return false;
      }
    }
    if (key.meta) {
      if (input === "b") return this.move(() => this.buffer.wordLeft());
      if (input === "f") return this.move(() => this.buffer.wordRight());
      return false;
    }
    if (key.escape || key.tab || key.pageUp || key.pageDown) return false;

    const text = stripControlCharacters(input);
    if (!text) return false;
    return this.edit(() => this.buffer.insert(text));
  }

  private handleAutocompleteKey(key: KeyPress): boolean {
    const state = this.autocompleteState!;
    if (key.upArrow || key.downArrow) {
      const count = state.items.length;
      const delta = key.upArrow ? -1 : 1;
      this.autocompleteState = {
        ...state,
        selected: (state.selected + delta + count) % count,
      };
      this.changed();
      return true;
    }
    if (key.escape) {
      this.closeAutocomplete();
      this.changed();
      return true;
    }
    if (key.tab && !key.shift) {
      this.acceptAutocomplete();
      return true;
    }
    if (key.return && !key.meta && !key.shift) {
      // Enter on an already complete command runs it; otherwise it completes.
      const item = state.items[state.selected];
      const { row, col } = this.buffer.cursor;
      const before = (this.buffer.lineList[row] ?? "").slice(0, col);
      if (item && before === `/${item.value}`) {
        this.closeAutocomplete();
        return false;
      }
      this.acceptAutocomplete();
      return true;
    }
    return false;
  }

  private acceptAutocomplete(): void {
    const state = this.autocompleteState;
    const provider = this.autocompleteProvider;
    const item = state?.items[state.selected];
    this.closeAutocomplete();
    if (!state || !provider || !item) return;
    const { row, col } = this.buffer.cursor;
    const result = provider.applyCompletion(
      [...this.buffer.lineList],
      row,
      col,
      item,
      state.prefix,
    );
    this.buffer.setState(result.lines, result.cursorLine, result.cursorCol);
    this.changed();
    // Keep completing inside a directory that was just accepted.
    if (item.value.replace(/"$/, "").endsWith("/")) this.refreshAutocomplete();
  }

  private closeAutocomplete(): void {
    this.autocompleteRequest++;
    this.autocompleteAbort?.abort();
    this.autocompleteAbort = null;
    this.autocompleteState = null;
  }

  /** Looks up suggestions for the text before the cursor; Tab forces paths. */
  private refreshAutocomplete(force = false): void {
    const provider = this.autocompleteProvider;
    const { row, col } = this.buffer.cursor;
    const lines = [...this.buffer.lineList];
    const before = (lines[row] ?? "").slice(0, col);
    const relevant =
      force ||
      extractMentionPrefix(before) !== null ||
      (row === 0 && before.startsWith("/") && !/\s/.test(before));
    if (!provider || !relevant) {
      if (this.autocompleteState) {
        this.closeAutocomplete();
        this.changed();
      }
      return;
    }
    if (force && !provider.shouldTriggerFileCompletion(lines, row, col)) return;

    this.autocompleteAbort?.abort();
    const abort = new AbortController();
    this.autocompleteAbort = abort;
    const request = ++this.autocompleteRequest;
    void provider
      .getSuggestions(lines, row, col, { signal: abort.signal, force })
      .then((suggestions) => {
        if (request !== this.autocompleteRequest) return;
        this.autocompleteAbort = null;
        if (!suggestions || suggestions.items.length === 0) {
          this.autocompleteState = null;
        } else if (force && suggestions.items.length === 1) {
          this.autocompleteState = { ...suggestions, selected: 0 };
          this.acceptAutocomplete();
          return;
        } else {
          this.autocompleteState = { ...suggestions, selected: 0 };
        }
        this.changed();
      })
      .catch(() => {
        if (request === this.autocompleteRequest) this.autocompleteState = null;
      });
  }

  private submitOrContinue(): void {
    const { row, col } = this.buffer.cursor;
    const line = this.buffer.lineList[row] ?? "";
    // A trailing backslash continues the prompt on a new line.
    if (col > 0 && line[col - 1] === "\\") {
      this.buffer.backspace();
      this.buffer.newline();
      this.changed();
      return;
    }
    if (this.editingQueueId) {
      this.finishQueueEdit();
      return;
    }
    const text = this.buffer.text;
    this.buffer.setText("");
    this.historyIndex = -1;
    this.historyDraft = "";
    this.closeAutocomplete();
    this.changed();
    this.onSubmit?.(text);
  }

  private historyOlder(): void {
    if (this.history.length === 0) return;
    if (this.historyIndex === -1) {
      this.historyDraft = this.buffer.text;
      this.historyIndex = this.history.length - 1;
    } else if (this.historyIndex > 0) {
      this.historyIndex--;
    } else {
      return;
    }
    this.buffer.setText(this.history[this.historyIndex]!);
  }

  private historyNewer(): void {
    if (this.historyIndex === -1) return;
    if (this.historyIndex < this.history.length - 1) {
      this.historyIndex++;
      this.buffer.setText(this.history[this.historyIndex]!);
    } else {
      this.historyIndex = -1;
      this.buffer.setText(this.historyDraft);
    }
  }

  private navigateQueuedMessages(direction: -1 | 1): boolean {
    const items = this.queuedMessages?.() ?? [];
    if (items.length === 0) {
      if (this.editingQueueId) this.finishQueueEdit();
      return false;
    }

    if (!this.editingQueueId) {
      if (direction > 0) return false;
      this.queueDraft = this.buffer.text;
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

    const previousId = this.editingQueueId;
    const previousText = this.buffer.text;
    this.editingQueueId = null;
    this.onQueuedMessageEditFinish?.(previousId, previousText);
    this.selectQueuedMessage(items[nextIndex]!);
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
    const text = this.buffer.text;
    const draft = this.queueDraft;
    this.editingQueueId = null;
    this.queueDraft = "";
    this.onQueuedMessageEditFinish?.(id, text);
    this.setText(draft);
  }

  private edit(apply: () => unknown): true {
    apply();
    this.historyIndex = -1;
    this.changed();
    this.refreshAutocomplete();
    return true;
  }

  private move(apply: () => void): true {
    apply();
    this.closeAutocomplete();
    this.changed();
    return true;
  }

  private changed(): void {
    this.version++;
    const text = this.buffer.text;
    if (text !== this.lastText) {
      this.lastText = text;
      this.onChange?.(text);
    }
    for (const listener of this.listeners) listener();
  }
}

function stripControlCharacters(input: string): string {
  return input
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "    ")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "");
}
