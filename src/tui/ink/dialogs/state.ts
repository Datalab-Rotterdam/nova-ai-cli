import { OTHER_OPTION_ID } from "../../../core/user-questions.js";
import type {
  PermissionRequestView,
  QuestionRequestView,
  ToolCallView,
} from "../../state/types.js";
import { TextBuffer } from "../editor/buffer.js";
import type { KeyPress } from "../editor/prompt-editor.js";

export type SelectionItem = {
  value: string;
  label: string;
  description?: string;
  columns?: { leading: string; main: string; trailing: string };
};

/** What a dialog wants after a key: nothing, a redraw, or to close. */
export type DialogResult = "ignored" | "changed" | "closed";

const isCancel = (input: string, key: KeyPress) =>
  !!key.escape || (!!key.ctrl && input === "c");

/** First visible row for a window of `rows` centred on `selected`. */
export function windowStart(selected: number, count: number, rows: number): number {
  const maximum = Math.max(0, count - rows);
  return Math.max(0, Math.min(selected - Math.floor(rows / 2), maximum));
}

export class SelectionState {
  selected = 0;

  constructor(
    readonly items: SelectionItem[],
    private readonly onSelect: (item: SelectionItem) => void,
    private readonly onCancel: () => void,
  ) {}

  handleKey(input: string, key: KeyPress, pageRows: number): DialogResult {
    const count = this.items.length;
    if (isCancel(input, key)) {
      this.onCancel();
      return "closed";
    }
    if (key.return) {
      const item = this.items[this.selected];
      if (!item) return "ignored";
      this.onSelect(item);
      return "closed";
    }
    if (count === 0) return "ignored";
    let next = this.selected;
    if (key.upArrow) next = this.selected === 0 ? count - 1 : this.selected - 1;
    else if (key.downArrow) next = this.selected === count - 1 ? 0 : this.selected + 1;
    else if (key.pageUp) next = Math.max(0, this.selected - pageRows);
    else if (key.pageDown) next = Math.min(count - 1, this.selected + pageRows);
    else if (key.home) next = 0;
    else if (key.end) next = count - 1;
    else return "ignored";
    if (next === this.selected) return "ignored";
    this.selected = next;
    return "changed";
  }
}

export class ScrollState {
  offset = 0;

  constructor(private readonly onClose: () => void) {}

  handleKey(input: string, key: KeyPress, pageRows: number): DialogResult {
    if (isCancel(input, key) || (key.return && !key.meta)) {
      this.onClose();
      return "closed";
    }
    const page = Math.max(1, pageRows);
    const before = this.offset;
    if (key.upArrow) this.offset = Math.max(0, this.offset - 1);
    else if (key.downArrow) this.offset += 1;
    else if (key.pageUp) this.offset = Math.max(0, this.offset - page);
    else if (key.pageDown || input === " ") this.offset += page;
    else if (key.home) this.offset = 0;
    else if (key.end) this.offset = Number.MAX_SAFE_INTEGER;
    else return "ignored";
    return this.offset === before ? "ignored" : "changed";
  }

  /** Clamps the offset to the content; call before rendering. */
  clamp(totalRows: number, visibleRows: number): number {
    this.offset = Math.max(0, Math.min(this.offset, totalRows - visibleRows));
    return this.offset;
  }
}

export class ToolInspectorState {
  selected = 0;
  expanded = false;
  detailOffset = 0;

  constructor(
    private readonly getCalls: () => ToolCallView[],
    private readonly onClose: () => void,
  ) {}

  calls(): ToolCallView[] {
    const calls = this.getCalls();
    this.selected = Math.max(0, Math.min(this.selected, calls.length - 1));
    return calls;
  }

  handleKey(input: string, key: KeyPress, pageRows: number): DialogResult {
    if (isCancel(input, key)) {
      this.onClose();
      return "closed";
    }
    const calls = this.calls();
    if (calls.length === 0) return "ignored";
    const before = `${this.selected}:${this.expanded}:${this.detailOffset}`;
    if (key.upArrow) this.select(this.selected === 0 ? calls.length - 1 : this.selected - 1);
    else if (key.downArrow)
      this.select(this.selected === calls.length - 1 ? 0 : this.selected + 1);
    else if (key.leftArrow) this.setExpanded(false);
    else if (key.rightArrow) this.setExpanded(true);
    else if (key.return || input === " ") this.setExpanded(!this.expanded);
    else if (key.pageUp) {
      if (this.expanded) this.detailOffset = Math.max(0, this.detailOffset - pageRows);
      else this.select(Math.max(0, this.selected - pageRows));
    } else if (key.pageDown) {
      if (this.expanded) this.detailOffset += pageRows;
      else this.select(Math.min(calls.length - 1, this.selected + pageRows));
    } else if (key.home) {
      if (this.expanded) this.detailOffset = 0;
      else this.select(0);
    } else if (key.end) {
      if (this.expanded) this.detailOffset = Number.MAX_SAFE_INTEGER;
      else this.select(calls.length - 1);
    } else return "ignored";
    return before === `${this.selected}:${this.expanded}:${this.detailOffset}`
      ? "ignored"
      : "changed";
  }

  private select(index: number): void {
    if (index === this.selected) return;
    this.selected = index;
    this.detailOffset = 0;
  }

  private setExpanded(expanded: boolean): void {
    if (expanded === this.expanded) return;
    this.expanded = expanded;
    this.detailOffset = 0;
  }
}

export class QuestionState {
  questionIndex = 0;
  selected = 0;
  customMode = false;
  validationMessage = "";
  readonly customInput = new TextBuffer();
  private readonly selections = new Map<string, Set<string>>();
  private readonly customAnswers = new Map<string, string>();

  constructor(
    readonly pending: QuestionRequestView,
    private readonly onClose: () => void,
  ) {}

  get question() {
    return this.pending.request.questions[this.questionIndex];
  }

  isSelected(questionId: string, optionId: string): boolean {
    return this.selection(questionId).has(optionId);
  }

  customAnswer(questionId: string): string | undefined {
    return this.customAnswers.get(questionId);
  }

  handleKey(input: string, key: KeyPress): DialogResult {
    if (this.customMode) return this.handleCustomKey(input, key);
    const question = this.question;
    if (!question) return "ignored";
    const count = question.options.length + 1;

    if (isCancel(input, key)) {
      this.pending.resolve({ action: "cancel", answers: [] });
      this.onClose();
      return "closed";
    }
    if (key.upArrow) return this.moveTo((this.selected - 1 + count) % count);
    if (key.downArrow) return this.moveTo((this.selected + 1) % count);
    if (key.home) return this.moveTo(0);
    if (key.end) return this.moveTo(count - 1);
    if (input === " " && question.type === "multiple") return this.toggleCurrent();
    if (key.return) return this.submitCurrent();
    return "ignored";
  }

  private handleCustomKey(input: string, key: KeyPress): DialogResult {
    if (key.escape) {
      this.customMode = false;
      this.validationMessage = "";
      return "changed";
    }
    if (key.ctrl && input === "c") {
      this.pending.resolve({ action: "cancel", answers: [] });
      this.onClose();
      return "closed";
    }
    if (key.return) return this.submitCustom(this.customInput.text);
    if (key.backspace) this.customInput.backspace();
    else if (key.delete) this.customInput.deleteForward();
    else if (key.leftArrow) this.customInput.left();
    else if (key.rightArrow) this.customInput.right();
    else if (key.home || (key.ctrl && input === "a")) this.customInput.lineStart();
    else if (key.end || (key.ctrl && input === "e")) this.customInput.lineEnd();
    else if (key.ctrl && input === "u") this.customInput.deleteToLineStart();
    else if (key.ctrl || key.meta || key.tab || key.upArrow || key.downArrow) return "ignored";
    else {
      const text = input.replace(/[\u0000-\u001f\u007f]/g, "");
      if (!text) return "ignored";
      this.customInput.insert(text);
    }
    return "changed";
  }

  /** Typed text from a paste while writing an own answer. */
  paste(text: string): DialogResult {
    if (!this.customMode) return "ignored";
    this.customInput.insert(text.replace(/\s*\n\s*/g, " ").replace(/[\u0000-\u001f\u007f]/g, ""));
    return "changed";
  }

  private moveTo(index: number): DialogResult {
    if (index === this.selected) return "ignored";
    this.selected = index;
    this.validationMessage = "";
    return "changed";
  }

  private toggleCurrent(): DialogResult {
    const question = this.question!;
    if (this.selected === question.options.length) return this.enterCustomMode();
    const option = question.options[this.selected];
    if (!option) return "ignored";
    const selection = this.selection(question.id);
    if (selection.has(option.id)) selection.delete(option.id);
    else selection.add(option.id);
    this.validationMessage = "";
    return "changed";
  }

  private submitCurrent(): DialogResult {
    const question = this.question!;
    if (this.selected === question.options.length) return this.enterCustomMode();
    if (question.type === "single") {
      const option = question.options[this.selected];
      if (!option) return "ignored";
      this.selections.set(question.id, new Set([option.id]));
      return this.advance();
    }
    if (this.selection(question.id).size === 0) {
      this.validationMessage = "Select at least one option before continuing.";
      return "changed";
    }
    return this.advance();
  }

  private enterCustomMode(): DialogResult {
    const question = this.question!;
    this.customMode = true;
    this.validationMessage = "";
    this.customInput.setText(this.customAnswers.get(question.id) ?? "");
    return "changed";
  }

  private submitCustom(value: string): DialogResult {
    const question = this.question!;
    const answer = value.trim();
    if (!answer) {
      this.validationMessage = "Enter your own answer before continuing.";
      return "changed";
    }
    if (question.type === "single") {
      this.selections.set(question.id, new Set([OTHER_OPTION_ID]));
    } else {
      this.selection(question.id).add(OTHER_OPTION_ID);
    }
    this.customAnswers.set(question.id, answer);
    this.customMode = false;
    return this.advance();
  }

  private advance(): DialogResult {
    this.validationMessage = "";
    if (this.questionIndex < this.pending.request.questions.length - 1) {
      this.questionIndex++;
      this.selected = 0;
      return "changed";
    }
    this.pending.resolve({
      action: "accept",
      answers: this.pending.request.questions.map((question) => ({
        questionId: question.id,
        selectedOptionIds: [...this.selection(question.id)],
        customAnswer: this.customAnswers.get(question.id),
      })),
    });
    this.onClose();
    return "closed";
  }

  private selection(questionId: string): Set<string> {
    let selected = this.selections.get(questionId);
    if (!selected) {
      selected = new Set<string>();
      this.selections.set(questionId, selected);
    }
    return selected;
  }
}

/** a/Enter once, s session, w always, d/Esc deny. */
export function permissionKey(
  request: PermissionRequestView,
  input: string,
  key: KeyPress,
): DialogResult {
  if (input === "a" || key.return) request.resolve(true, "once");
  else if (input === "s") request.resolve(true, "session");
  else if (input === "w") request.resolve(true, "always");
  else if (input === "d" || isCancel(input, key)) request.resolve(false, "once");
  else return "ignored";
  return "closed";
}
