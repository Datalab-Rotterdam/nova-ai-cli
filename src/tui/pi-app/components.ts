import { diffLines } from "diff";
import {
  Container,
  Input,
  Key,
  Markdown,
  Text,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type SelectItem,
  type SelectListTheme,
} from "@earendil-works/pi-tui";
import { OTHER_OPTION_ID } from "../../acp/user-questions.js";
import type { Store } from "../state/store.js";
import type { ToolCallView, UIMessage, UIState } from "../state/types.js";
import { colors, markdownTheme } from "./theme.js";

const ASSISTANT_MARKER = String.fromCodePoint(0x2726);
const WORKING_FRAMES = [ASSISTANT_MARKER, "✧", "·", "✧"] as const;

type QuestionAnchor = {
  start: number;
  after: number;
  lines: string[];
};

export type SelectionItem = SelectItem & {
  columns?: {
    leading: string;
    main: string;
    trailing: string;
  };
};

type TranscriptCache = {
  state: UIState;
  width: number;
  expanded: boolean;
  lines: string[];
  questions: QuestionAnchor[];
};

type ChangedLine = { kind: "added" | "removed"; text: string };

function appendWrapped(target: string[], text: string, width: number): void {
  target.push(...new Text(text, 0, 0).render(Math.max(1, width)));
}

function prefixed(lines: string[], prefix: string, width: number): string[] {
  const available = Math.max(1, width - visibleWidth(prefix));
  return lines.flatMap((line, index) => {
    const wrapped = wrapTextWithAnsi(line, available);
    return wrapped.map(
      (part, partIndex) =>
        `${index === 0 && partIndex === 0 ? prefix : " ".repeat(visibleWidth(prefix))}${part}`,
    );
  });
}

function fillLine(text: string, width: number): string {
  return truncateToWidth(text, Math.max(1, width), "", true);
}

/** Returns -1 for wheel up, 1 for wheel down, and null for non-wheel input. */
export function mouseWheelDelta(data: string): -1 | 1 | null {
  const match = /^\u001b\[<(\d+);\d+;\d+[Mm]$/.exec(data);
  if (!match) return null;
  const button = Number(match[1]);
  if ((button & 64) !== 64) return null;
  return (button & 1) === 0 ? -1 : 1;
}

export class TranscriptView implements Component {
  private state: UIState;
  private expandedTools = false;
  private animationFrame = 0;
  private cache: TranscriptCache | null = null;

  constructor(private readonly store: Store<UIState>) {
    this.state = store.getState();
  }

  sync(): void {
    this.state = this.store.getState();
    this.invalidate();
  }

  toggleToolDetails(): void {
    this.expandedTools = !this.expandedTools;
    this.invalidate();
  }

  areToolDetailsExpanded(): boolean {
    return this.expandedTools;
  }

  toolCalls(): ToolCallView[] {
    return this.state.messages.flatMap((message) =>
      message.role === "tool" ? [message.call] : [],
    );
  }

  invalidate(): void {
    this.cache = null;
  }

  advanceAnimation(): boolean {
    const active =
      this.state.busy ||
      this.state.messages.some(
        (message) =>
          message.role === "tool" && message.call.status === "pending",
      );
    if (!active) return false;
    this.animationFrame = (this.animationFrame + 1) % WORKING_FRAMES.length;
    this.invalidate();
    return true;
  }

  render(width: number): string[] {
    if (
      this.cache?.state === this.state &&
      this.cache.width === width &&
      this.cache.expanded === this.expandedTools
    ) {
      return this.cache.lines;
    }

    const contentWidth = Math.max(1, width - 2);
    const lines: string[] = [];
    const questions: QuestionAnchor[] = [];

    appendWrapped(
      lines,
      `  ${colors.primary(`${ASSISTANT_MARKER} Nova AI`)}`,
      width,
    );
    appendWrapped(
      lines,
      `  ${colors.muted(`Workspace: ${this.state.cwd}`)}`,
      width,
    );
    if (this.state.messages.length === 0) {
      appendWrapped(
        lines,
        `  ${colors.faint("Ask a question, use @file, or type /help.")}`,
        width,
      );
    }

    for (let index = 0; index < this.state.messages.length; index++) {
      const message = this.state.messages[index];
      if (!message) continue;

      if (
        message.role === "tool" &&
        isActivityTool(message.call) &&
        !this.expandedTools
      ) {
        const calls = [message.call];
        while (index + 1 < this.state.messages.length) {
          const next = this.state.messages[index + 1];
          if (!next || next.role !== "tool" || !isActivityTool(next.call))
            break;
          calls.push(next.call);
          index++;
        }
        const rendered = renderActivityGroup(
          calls,
          contentWidth,
          this.animationFrame,
        ).map((line) => ` ${line}`);
        lines.push(...rendered);
        continue;
      }

      const rendered = this.renderMessage(message, contentWidth).map(
        (line) => ` ${line}`,
      );
      const start = lines.length;
      lines.push(...rendered);
      if (message.role === "user") {
        questions.push({ start, after: lines.length, lines: rendered });
      }
    }

    const hasPendingTool = this.state.messages.some(
      (message) => message.role === "tool" && message.call.status === "pending",
    );
    if (this.state.busy && !hasPendingTool) {
      lines.push(
        ` ${colors.accent(WORKING_FRAMES[this.animationFrame]!)} ${colors.muted("Working…")}`,
      );
    }

    this.cache = {
      state: this.state,
      width,
      expanded: this.expandedTools,
      lines,
      questions,
    };
    return lines;
  }

  stickyQuestion(
    width: number,
    firstVisibleRow: number,
  ): QuestionAnchor | null {
    this.render(width);
    const questions = this.cache?.questions ?? [];
    for (let index = questions.length - 1; index >= 0; index--) {
      const question = questions[index];
      if (question && question.start <= firstVisibleRow) {
        return question.start < firstVisibleRow ? question : null;
      }
    }
    return null;
  }

  private renderMessage(message: UIMessage, width: number): string[] {
    switch (message.role) {
      case "user":
        return prefixed(
          new Text(colors.primary(message.text), 0, 0).render(
            Math.max(1, width - 2),
          ),
          colors.primary("> "),
          width,
        );
      case "assistant": {
        const markdown = new Markdown(
          message.text.replace(/^\s+/, "") ||
            (message.streaming ? "Working..." : ""),
          0,
          0,
          markdownTheme,
        );
        return prefixed(
          markdown.render(Math.max(1, width - 2)),
          colors.accent(`${ASSISTANT_MARKER} `),
          width,
        );
      }
      case "error":
        return prefixed(
          new Text(colors.danger(message.text), 0, 0).render(
            Math.max(1, width - 2),
          ),
          colors.danger("! "),
          width,
        );
      case "tool":
        return renderToolCall(
          message.call,
          width,
          this.expandedTools,
          this.animationFrame,
        );
      case "background": {
        const status =
          message.job.status === "failed" || message.job.status === "killed"
            ? colors.danger(message.job.status)
            : message.job.status === "completed"
              ? colors.success(message.job.status)
              : colors.warning(message.job.status);
        const heading = `${colors.accent("background")} ${message.job.kind}: ${message.job.title} [${status}]`;
        const result = new Text(heading, 0, 0).render(width);
        if (this.expandedTools && message.job.preview) {
          result.push(
            ...new Text(colors.muted(message.job.preview), 2, 0).render(width),
          );
        }
        return result;
      }
    }
  }
}

export class StatusView implements Component {
  private state: UIState;
  private model: string;
  private mcp: {
    configured: number;
    connected: number;
    failed: number;
    skills?: number;
  };

  constructor(
    store: Store<UIState>,
    model: string,
    mcp: {
      configured: number;
      connected: number;
      failed: number;
      skills?: number;
    },
  ) {
    this.state = store.getState();
    this.model = model;
    this.mcp = mcp;
  }

  update(
    state: UIState,
    model: string,
    mcp: {
      configured: number;
      connected: number;
      failed: number;
      skills?: number;
    },
  ): void {
    this.state = state;
    this.model = model;
    this.mcp = mcp;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const activity = this.state.busy
      ? colors.warning("working")
      : colors.success("ready");
    const usage = this.state.contextUsage
      ? ` | ctx:${formatTokenCount(this.state.contextUsage.totalTokens)}${this.state.contextUsage.contextWindow ? `/${formatTokenCount(this.state.contextUsage.contextWindow)}` : ""}`
      : "";
    const queue = this.state.queuedCount
      ? ` | queued:${this.state.queuedCount}`
      : "";
    const mcp = this.mcp.configured
      ? ` | mcp:${this.mcp.connected}/${this.mcp.configured}${this.mcp.failed ? colors.danger(` !${this.mcp.failed}`) : ""}`
      : "";
    const skills = this.mcp.skills ? ` | skills:${this.mcp.skills}` : "";
    const status = this.state.statusLine ? ` | ${this.state.statusLine}` : "";
    const line = `${colors.muted(this.model)} | ${this.state.interactionMode} | ${this.state.permissionMode} | ${activity}${usage}${queue}${mcp}${skills}${status}`;
    return [truncateToWidth(line, width, "")];
  }
}

export function formatTokenCount(value: number): string {
  if (value >= 1_000_000) {
    const millions = value / 1_000_000;
    return `${millions >= 10 ? Math.round(millions) : millions.toFixed(1).replace(/\.0$/, "")}m`;
  }
  if (value >= 1_000) {
    const thousands = value / 1_000;
    return `${thousands >= 10 ? Math.round(thousands) : thousands.toFixed(1).replace(/\.0$/, "")}k`;
  }
  return String(value);
}

export class BorderedWindow implements Component {
  constructor(
    private readonly child: Component,
    private readonly maxRows?: () => number,
  ) {}

  handleInput(data: string): void {
    this.child.handleInput?.(data);
  }

  invalidate(): void {
    this.child.invalidate?.();
  }

  render(width: number): string[] {
    if (width < 3)
      return this.child
        .render(Math.max(1, width))
        .map((line) => fillLine(line, width));

    const innerWidth = width - 2;
    const horizontal = colors.primary(`┌${"─".repeat(innerWidth)}┐`);
    const bottom = colors.primary(`└${"─".repeat(innerWidth)}┘`);
    const side = colors.primary("│");
    let childLines = this.child.render(innerWidth);
    const maximumContentRows = this.maxRows
      ? Math.max(1, this.maxRows() - 2)
      : Number.MAX_SAFE_INTEGER;
    if (childLines.length > maximumContentRows) {
      childLines =
        maximumContentRows === 1
          ? [childLines.at(-1) ?? ""]
          : [
              ...childLines.slice(0, maximumContentRows - 1),
              childLines.at(-1) ?? "",
            ];
    }
    const content = childLines.map(
      (line) => `${side}${fillLine(line, innerWidth)}${side}`,
    );
    return [horizontal, ...content, bottom];
  }
}

/**
 * Full-terminal layout with a scrollable transcript and a footer pinned to the
 * bottom edge. The returned row count always matches the current terminal
 * height, which lets Pi TUI fully repaint after both width and height changes.
 */
export class FullscreenLayout extends Container {
  private scrollFromBottom = 0;
  private previousContentRows = 0;
  private previousWidth = 0;
  private fullscreenSurface: Component | null = null;

  constructor(
    private readonly transcript: TranscriptView,
    private readonly status: Component,
    private readonly editor: Component,
    private readonly terminalRows: () => number,
    private readonly requestRender: () => void,
  ) {
    super();
    this.addChild(transcript);
    this.addChild(editor);
    this.addChild(status);
  }

  render(width: number): string[] {
    const height = Math.max(1, this.terminalRows());

    if (this.fullscreenSurface) {
      const rows = this.fullscreenSurface
        .render(width)
        .slice(0, height)
        .map((line) => fillLine(line, width));
      while (rows.length < height) rows.push(fillLine("", width));
      return rows;
    }

    const footer = [...this.editor.render(width), ...this.status.render(width)];

    if (footer.length >= height) {
      return footer.slice(-height);
    }

    const bodyHeight = height - footer.length;
    const content = this.transcript.render(width);

    // Keep the same history in view while a streamed response grows. Reflow
    // after a width change is clamped instead because row counts are unrelated.
    if (
      width === this.previousWidth &&
      this.scrollFromBottom > 0 &&
      content.length > this.previousContentRows
    ) {
      this.scrollFromBottom += content.length - this.previousContentRows;
    }
    this.previousWidth = width;
    this.previousContentRows = content.length;

    let scrollBodyHeight = bodyHeight;
    let start = 0;
    let question: QuestionAnchor | null = null;
    let sticky: string[] = [];

    // Reserving sticky rows can move the first visible content row into the
    // next turn. Iterate until the pinned question and viewport agree.
    for (let pass = 0; pass < 4; pass++) {
      start = this.contentStart(content.length, scrollBodyHeight);
      const nextQuestion = this.transcript.stickyQuestion(width, start);
      const nextSticky =
        nextQuestion && bodyHeight > 1
          ? renderStickyQuestion(nextQuestion, width, bodyHeight)
          : [];
      const stable =
        nextQuestion?.start === question?.start &&
        nextSticky.length === sticky.length;
      question = nextQuestion;
      sticky = nextSticky;
      scrollBodyHeight = Math.max(1, bodyHeight - sticky.length);
      if (stable) break;
    }

    start = this.contentStart(content.length, scrollBodyHeight);
    if (question) start = Math.max(start, question.after);

    const visible = content.slice(start, start + scrollBodyHeight);

    while (visible.length < scrollBodyHeight) visible.push("");
    return [...sticky, ...visible, ...footer];
  }

  private contentStart(contentRows: number, bodyRows: number): number {
    const maximum = Math.max(0, contentRows - bodyRows);
    this.scrollFromBottom = Math.min(this.scrollFromBottom, maximum);
    return Math.max(0, contentRows - bodyRows - this.scrollFromBottom);
  }

  scrollOlder(rows: number): void {
    this.scrollFromBottom += Math.max(1, rows);
    this.requestRender();
  }

  scrollNewer(rows: number): void {
    this.scrollFromBottom = Math.max(
      0,
      this.scrollFromBottom - Math.max(1, rows),
    );
    this.requestRender();
  }

  pageRows(): number {
    return Math.max(1, this.terminalRows() - 6);
  }

  scrollToTop(): void {
    this.scrollFromBottom = Number.MAX_SAFE_INTEGER;
    this.requestRender();
  }

  scrollToBottom(): void {
    this.scrollFromBottom = 0;
    this.requestRender();
  }

  showFullscreen(component: Component): void {
    if (this.fullscreenSurface) this.removeChild(this.fullscreenSurface);
    this.fullscreenSurface = component;
    this.addChild(component);
  }

  hideFullscreen(): void {
    if (!this.fullscreenSurface) return;
    this.removeChild(this.fullscreenSurface);
    this.fullscreenSurface = null;
  }

  hasFullscreen(): boolean {
    return this.fullscreenSurface !== null;
  }
}

export class SelectionDialog implements Component {
  private selectedIndex = 0;

  constructor(
    private readonly title: string,
    private readonly items: SelectionItem[],
    private readonly theme: SelectListTheme,
    private readonly maxVisibleRows: () => number,
    private readonly requestRender: () => void,
    private readonly onSelect: (item: SelectionItem) => void,
    private readonly onCancel: () => void,
  ) {}

  handleInput(data: string): void {
    const wheel = mouseWheelDelta(data);
    if (wheel !== null) {
      this.move(wheel * 3, false);
    } else if (matchesKey(data, Key.up)) {
      this.move(-1, true);
    } else if (matchesKey(data, Key.down)) {
      this.move(1, true);
    } else if (matchesKey(data, Key.pageUp)) {
      this.move(-this.visibleRows(), false);
    } else if (matchesKey(data, Key.pageDown)) {
      this.move(this.visibleRows(), false);
    } else if (matchesKey(data, Key.home)) {
      this.setSelectedIndex(0);
    } else if (matchesKey(data, Key.end)) {
      this.setSelectedIndex(this.items.length - 1);
    } else if (matchesKey(data, Key.enter)) {
      const selected = this.items[this.selectedIndex];
      if (selected) this.onSelect(selected);
    } else if (
      matchesKey(data, Key.escape) ||
      matchesKey(data, Key.ctrl("c"))
    ) {
      this.onCancel();
    }
  }

  invalidate(): void {}

  render(width: number): string[] {
    const visibleRows = this.visibleRows();
    const maximumStart = Math.max(0, this.items.length - visibleRows);
    const start = Math.max(
      0,
      Math.min(this.selectedIndex - Math.floor(visibleRows / 2), maximumStart),
    );
    const rows = this.items
      .slice(start, start + visibleRows)
      .map((item, index) =>
        this.renderItem(item, start + index === this.selectedIndex, width),
      );

    // Keep a stable, opaque rectangle so every scroll frame overwrites the
    // cells occupied by the previous frame.
    while (rows.length < visibleRows) rows.push(fillLine("", width));
    return [
      fillLine(colors.primary(this.title), width),
      fillLine(
        colors.faint("Wheel/arrows/page navigate | Enter select | Esc close"),
        width,
      ),
      fillLine("", width),
      ...rows,
      fillLine(
        colors.faint(`${this.selectedIndex + 1}/${this.items.length}`),
        width,
      ),
    ];
  }

  private visibleRows(): number {
    // Reserve the complete viewport even when there are only a few items. This
    // makes the picker an opaque screen rather than a transparent content box.
    return Math.max(1, this.maxVisibleRows());
  }

  private move(delta: number, wrap: boolean): void {
    if (this.items.length === 0) return;
    let next = this.selectedIndex + delta;
    if (wrap && delta < 0 && this.selectedIndex === 0)
      next = this.items.length - 1;
    else if (wrap && delta > 0 && this.selectedIndex === this.items.length - 1)
      next = 0;
    this.setSelectedIndex(next);
  }

  private setSelectedIndex(index: number): void {
    const next = Math.max(0, Math.min(index, this.items.length - 1));
    if (next === this.selectedIndex) return;
    this.selectedIndex = next;
    this.requestRender();
  }

  private renderItem(
    item: SelectionItem,
    selected: boolean,
    width: number,
  ): string {
    const prefix = selected ? this.theme.selectedPrefix("> ") : "  ";
    const prefixWidth = visibleWidth(prefix);
    if (item.columns) {
      return this.renderColumns(item.columns, selected, width, prefix, prefixWidth);
    }
    const description = item.description?.replace(/[\r\n]+/g, " ").trim();
    const available = Math.max(1, width - prefixWidth);
    const labelWidth =
      description && width >= 44
        ? Math.max(10, Math.min(32, Math.floor(available * 0.45)))
        : available;
    const label = truncateToWidth(item.label || item.value, labelWidth, "");
    let line = `${prefix}${selected ? this.theme.selectedText(label) : label}`;

    if (description && width >= 44) {
      const gap = " ".repeat(Math.max(2, labelWidth - visibleWidth(label) + 2));
      const descriptionWidth = Math.max(
        1,
        width - visibleWidth(line) - visibleWidth(gap),
      );
      line += `${gap}${this.theme.description(truncateToWidth(description, descriptionWidth, ""))}`;
    }
    return fillLine(line, width);
  }

  private renderColumns(
    columns: NonNullable<SelectionItem["columns"]>,
    selected: boolean,
    width: number,
    prefix: string,
    prefixWidth: number,
  ): string {
    const clean = (value: string) => value.replace(/\s+/g, " ").trim();
    const leading = clean(columns.leading);
    const main = clean(columns.main);
    const trailing = clean(columns.trailing);
    const leadingWidth = Math.min(
      14,
      Math.max(
        visibleWidth(leading),
        ...this.items.flatMap((item) =>
          item.columns ? [visibleWidth(clean(item.columns.leading))] : [],
        ),
      ),
    );
    const separator = "  ";
    const available = Math.max(1, width - prefixWidth);
    const fixedWidth = leadingWidth + visibleWidth(separator) * 2 + visibleWidth(trailing);
    const mainWidth = Math.max(0, available - fixedWidth);

    const renderedLeading = truncateToWidth(leading, leadingWidth, "").padEnd(
      leadingWidth,
    );
    const renderedMain = mainWidth > 0 ? truncateToWidth(main, mainWidth, "") : "";
    const left = selected
      ? this.theme.selectedText(renderedLeading)
      : renderedLeading;
    const middle = selected
      ? this.theme.selectedText(renderedMain)
      : renderedMain;

    if (mainWidth > 0) {
      return fillLine(
        `${prefix}${left}${separator}${middle}${separator}${this.theme.description(trailing)}`,
        width,
      );
    }

    // Very narrow terminals cannot display all three values. Preserve the
    // exact timestamp for as long as the row can hold the two fixed columns.
    const twoColumns = `${prefix}${left}${separator}${this.theme.description(trailing)}`;
    return fillLine(twoColumns, width);
  }
}

export class QuestionDialog implements Component {
  private questionIndex = 0;
  private selectedIndex = 0;
  private customMode = false;
  private validationMessage = "";
  private readonly selections = new Map<string, Set<string>>();
  private readonly customAnswers = new Map<string, string>();
  private readonly customInput = new Input();

  constructor(
    private readonly pending: NonNullable<UIState["pendingQuestion"]>,
    private readonly requestRender: () => void,
    private readonly close: () => void,
  ) {
    this.customInput.onSubmit = (value) => this.submitCustom(value);
    this.customInput.onEscape = () => this.leaveCustomMode();
  }

  handleInput(data: string): void {
    if (this.customMode) {
      this.customInput.handleInput(data);
      this.requestRender();
      return;
    }

    const question = this.currentQuestion();
    if (!question) return;
    const wheel = mouseWheelDelta(data);
    if (wheel !== null) this.move(wheel * 3);
    else if (matchesKey(data, Key.up)) this.move(-1);
    else if (matchesKey(data, Key.down)) this.move(1);
    else if (matchesKey(data, Key.home)) this.setSelectedIndex(0);
    else if (matchesKey(data, Key.end))
      this.setSelectedIndex(question.options.length);
    else if (data === " " && question.type === "multiple") this.toggleCurrent();
    else if (matchesKey(data, Key.enter)) this.submitCurrent();
    else if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.pending.resolve({ action: "cancel", answers: [] });
      this.close();
    }
  }

  invalidate(): void {
    this.customInput.invalidate();
  }

  render(width: number): string[] {
    const question = this.currentQuestion();
    if (!question) return [];
    if (this.customMode) return this.renderCustom(question, width);

    const selected = this.selection(question.id);
    const optionRows = [
      ...question.options.map((option, index) => {
        const checked = selected.has(option.id);
        const cursor = index === this.selectedIndex ? colors.primary(">") : " ";
        const mark =
          question.type === "multiple"
            ? checked
              ? colors.success("[x]")
              : "[ ]"
            : index === this.selectedIndex
              ? colors.primary("(o)")
              : "( )";
        const recommendation = option.recommended
          ? colors.success(" (recommended)")
          : "";
        const label = `${cursor} ${mark} ${option.label}${recommendation}`;
        return [
          truncateToWidth(label, width, ""),
          ...(option.description
            ? [
                truncateToWidth(
                  `      ${colors.muted(option.description.replace(/[\r\n]+/g, " "))}`,
                  width,
                  "",
                ),
              ]
            : []),
        ];
      }),
      this.renderOther(question.id, question.options.length, width),
    ].flat();
    const help =
      question.type === "multiple"
        ? "Arrows navigate | Space toggle | Enter continue | Esc cancel"
        : "Arrows navigate | Enter select | Esc cancel";

    return [
      colors.accent(this.pending.request.message),
      colors.faint(
        `Question ${this.questionIndex + 1}/${this.pending.request.questions.length} · ${question.type === "multiple" ? "select one or more" : "select one"}`,
      ),
      "",
      ...new Text(colors.primary(question.question), 0, 0)
        .render(width)
        .slice(0, 3),
      ...(question.description
        ? new Text(colors.muted(question.description), 0, 0)
            .render(width)
            .slice(0, 3)
        : []),
      "",
      ...optionRows,
      ...(this.validationMessage
        ? ["", colors.danger(this.validationMessage)]
        : []),
      "",
      colors.faint(help),
    ];
  }

  private renderCustom(
    question: NonNullable<ReturnType<QuestionDialog["currentQuestion"]>>,
    width: number,
  ): string[] {
    this.customInput.focused = true;
    return [
      colors.accent(this.pending.request.message),
      colors.faint(
        `Question ${this.questionIndex + 1}/${this.pending.request.questions.length} · own answer`,
      ),
      "",
      ...new Text(colors.primary(question.question), 0, 0)
        .render(width)
        .slice(0, 3),
      ...(question.description
        ? new Text(colors.muted(question.description), 0, 0)
            .render(width)
            .slice(0, 3)
        : []),
      "",
      colors.primary("Your answer"),
      ...this.customInput.render(width),
      ...(this.validationMessage
        ? [colors.danger(this.validationMessage)]
        : []),
      "",
      colors.faint("Enter submit | Esc back to choices"),
    ];
  }

  private renderOther(
    questionId: string,
    index: number,
    width: number,
  ): string {
    const selected = this.selection(questionId).has(OTHER_OPTION_ID);
    const cursor = index === this.selectedIndex ? colors.primary(">") : " ";
    const mark = selected ? colors.success("[x]") : "[ ]";
    const answer = this.customAnswers.get(questionId);
    const label = answer
      ? `Other: ${answer}`
      : "Other... (write your own answer)";
    return truncateToWidth(`${cursor} ${mark} ${label}`, width, "");
  }

  private submitCurrent(): void {
    const question = this.currentQuestion();
    if (!question) return;
    if (this.selectedIndex === question.options.length) {
      this.enterCustomMode();
      return;
    }
    if (question.type === "single") {
      const option = question.options[this.selectedIndex];
      if (!option) return;
      this.selections.set(question.id, new Set([option.id]));
      this.advance();
      return;
    }
    if (this.selection(question.id).size === 0) {
      this.validationMessage = "Select at least one option before continuing.";
      this.requestRender();
      return;
    }
    this.advance();
  }

  private toggleCurrent(): void {
    const question = this.currentQuestion();
    if (!question) return;
    if (this.selectedIndex === question.options.length) {
      this.enterCustomMode();
      return;
    }
    const option = question.options[this.selectedIndex];
    if (!option) return;
    const selection = this.selection(question.id);
    if (selection.has(option.id)) selection.delete(option.id);
    else selection.add(option.id);
    this.validationMessage = "";
    this.requestRender();
  }

  private enterCustomMode(): void {
    const question = this.currentQuestion();
    if (!question) return;
    this.customMode = true;
    this.validationMessage = "";
    this.customInput.setValue(this.customAnswers.get(question.id) ?? "");
    this.customInput.focused = true;
    this.requestRender();
  }

  private leaveCustomMode(): void {
    this.customMode = false;
    this.customInput.focused = false;
    this.validationMessage = "";
    this.requestRender();
  }

  private submitCustom(value: string): void {
    const question = this.currentQuestion();
    if (!question) return;
    const answer = value.trim();
    if (!answer) {
      this.validationMessage = "Enter your own answer before continuing.";
      this.requestRender();
      return;
    }
    if (question.type === "single") {
      this.selections.set(question.id, new Set([OTHER_OPTION_ID]));
    } else {
      this.selection(question.id).add(OTHER_OPTION_ID);
    }
    this.customAnswers.set(question.id, answer);
    this.customMode = false;
    this.customInput.focused = false;
    this.advance();
  }

  private advance(): void {
    this.validationMessage = "";
    if (this.questionIndex < this.pending.request.questions.length - 1) {
      this.questionIndex++;
      this.selectedIndex = 0;
      this.requestRender();
      return;
    }
    this.pending.resolve({
      action: "accept",
      answers: this.pending.request.questions.map((question) => ({
        questionId: question.id,
        selectedOptionIds: [...this.selection(question.id)],
        customAnswer: this.customAnswers.get(question.id),
      })),
    });
    this.close();
  }

  private move(delta: number): void {
    const question = this.currentQuestion();
    if (!question) return;
    const count = question.options.length + 1;
    this.setSelectedIndex((this.selectedIndex + delta + count) % count);
  }

  private setSelectedIndex(index: number): void {
    const question = this.currentQuestion();
    if (!question) return;
    const next = Math.max(0, Math.min(index, question.options.length));
    if (next === this.selectedIndex) return;
    this.selectedIndex = next;
    this.validationMessage = "";
    this.requestRender();
  }

  private selection(questionId: string): Set<string> {
    let selected = this.selections.get(questionId);
    if (!selected) {
      selected = new Set<string>();
      this.selections.set(questionId, selected);
    }
    return selected;
  }

  private currentQuestion() {
    return this.pending.request.questions[this.questionIndex];
  }
}

export class PermissionDialog implements Component {
  constructor(
    private readonly request: NonNullable<UIState["pendingPermission"]>,
    private readonly close: () => void,
  ) {}

  handleInput(data: string): void {
    if (matchesKey(data, "a") || matchesKey(data, Key.enter))
      this.request.resolve(true, "once");
    else if (matchesKey(data, "s")) this.request.resolve(true, "session");
    else if (matchesKey(data, "w")) this.request.resolve(true, "always");
    else if (
      matchesKey(data, "d") ||
      matchesKey(data, Key.escape) ||
      matchesKey(data, Key.ctrl("c"))
    ) {
      this.request.resolve(false, "once");
    } else return;
    this.close();
  }

  invalidate(): void {}

  render(width: number): string[] {
    const args = JSON.stringify(this.request.args, null, 2);
    return [
      colors.warning(`Permission requested: ${this.request.toolName}`),
      colors.muted(`${this.request.kind} tool`),
      "",
      ...new Text(args, 1, 0).render(width).slice(0, 12),
      "",
      colors.primary("[a] once  [s] session  [w] always  [d] deny"),
    ];
  }
}

export class ScrollPanel implements Component {
  private offset = 0;

  constructor(
    private readonly title: string,
    private readonly content: string,
    private readonly maxBodyRows: () => number,
    private readonly requestRender: () => void,
    private readonly close: () => void,
  ) {}

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.close();
      return;
    }
    const page = Math.max(1, this.maxBodyRows() - 3);
    if (matchesKey(data, Key.up)) this.offset = Math.max(0, this.offset - 1);
    else if (matchesKey(data, Key.down)) this.offset += 1;
    else if (matchesKey(data, Key.pageUp))
      this.offset = Math.max(0, this.offset - page);
    else if (matchesKey(data, Key.pageDown)) this.offset += page;
    else if (matchesKey(data, Key.home)) this.offset = 0;
    else if (matchesKey(data, Key.end)) this.offset = Number.MAX_SAFE_INTEGER;
    else return;
    this.requestRender();
  }

  invalidate(): void {}

  render(width: number): string[] {
    const rows = this.content
      .split(/\r?\n/)
      .flatMap((line) => wrapTextWithAnsi(line || " ", Math.max(1, width)));
    const bodyRows = Math.max(1, this.maxBodyRows() - 3);
    const maximum = Math.max(0, rows.length - bodyRows);
    this.offset = Math.min(this.offset, maximum);
    const visible = rows.slice(this.offset, this.offset + bodyRows);
    return [
      truncateToWidth(colors.primary(this.title), width, ""),
      ...visible,
      truncateToWidth(
        colors.faint(
          `${this.offset + 1}-${Math.min(rows.length, this.offset + visible.length)} of ${rows.length} · arrows/page/home/end · Esc close`,
        ),
        width,
        "",
      ),
    ];
  }
}

export function formatToolCallDetails(call: ToolCallView): string {
  const rows = [
    `${call.name} [${call.status}]`,
    `kind: ${call.kind}`,
    `mutating: ${call.mutating ? "yes" : "no"}`,
    "",
    "Arguments:",
    JSON.stringify(call.args, null, 2),
  ];
  if (call.diff) {
    rows.push("", `Diff: ${call.diff.path}`);
    for (const line of changedLines(
      call.diff.oldText ?? "",
      call.diff.newText,
    )) {
      rows.push(`${line.kind === "added" ? "+" : "-"} ${line.text}`);
    }
  }
  if (call.output) rows.push("", "Output:", call.output);
  return rows.join("\n");
}

function renderToolCall(
  call: ToolCallView,
  width: number,
  expanded: boolean,
  animationFrame = 0,
): string[] {
  const icon = toolStatusIcon(call.status, animationFrame);
  const path = typeof call.args.path === "string" ? call.args.path : null;
  const command =
    typeof call.args.command === "string" ? call.args.command : null;
  const summary = path ?? command ?? "";
  const heading = `${icon} ${colors.accent(call.name)}${call.mutating ? colors.warning(" (changes)") : ""}${summary ? `: ${summary}` : ""}`;
  const lines = new Text(heading, 1, 0).render(width);
  if (call.status === "failed")
    return [...lines, ...renderToolFailure(call.output, width)];
  if (call.diff)
    return [
      ...lines,
      ...renderChangedLines(call.diff.oldText ?? "", call.diff.newText, width),
    ];
  if (!expanded || isCompactTool(call)) return lines;
  return [
    ...lines,
    ...new Text(colors.muted(formatToolCallDetails(call)), 3, 0).render(width),
  ];
}

function renderActivityGroup(
  calls: ToolCallView[],
  width: number,
  animationFrame = 0,
): string[] {
  const status = calls.some((call) => call.status === "failed")
    ? "failed"
    : calls.some((call) => call.status === "pending")
      ? "pending"
      : "completed";
  const pending = status === "pending";
  const heading = `${toolStatusIcon(status, animationFrame)} ${colors.accent(activitySummary(calls, pending))}${pending ? colors.faint("…") : ""}`;
  const details = calls
    .flatMap(activityDetails)
    .map(sanitizeActivityLine)
    .filter(Boolean)
    .slice(-3);
  return [
    ...new Text(heading, 1, 0).render(width),
    ...details.map((detail, index) => {
      const prefix = index === 0 ? colors.faint("  ⎿  ") : "     ";
      return `${prefix}${truncateToWidth(colors.muted(detail), Math.max(1, width - visibleWidth(prefix)), "…")}`;
    }),
  ];
}

function toolStatusIcon(
  status: ToolCallView["status"],
  animationFrame = 0,
): string {
  return status === "pending"
    ? colors.warning(WORKING_FRAMES[animationFrame % WORKING_FRAMES.length]!)
    : status === "failed"
      ? colors.danger("!")
      : colors.success("✓");
}

function isCompactTool(call: ToolCallView): boolean {
  return !call.mutating || call.kind === "read" || call.kind === "search";
}

function isActivityTool(call: ToolCallView): boolean {
  return (
    isCompactTool(call) ||
    call.name === "run_command" ||
    call.name === "run_package_script"
  );
}

function activitySummary(calls: ToolCallView[], pending: boolean): string {
  const counts = { files: 0, directories: 0, searches: 0, shells: 0, other: 0 };
  for (const call of calls) {
    if (call.name === "read_file") counts.files++;
    else if (call.name === "list_directory") counts.directories++;
    else if (call.name === "search_text") counts.searches++;
    else if (call.name === "run_command" || call.name === "run_package_script")
      counts.shells++;
    else counts.other++;
  }

  const phrases = [
    activityPhrase(counts.files, pending ? "reading" : "read", "file"),
    activityPhrase(
      counts.directories,
      pending ? "listing" : "listed",
      "directory",
    ),
    activityPhrase(counts.searches, pending ? "searching" : "searched", "path"),
    activityPhrase(counts.shells, pending ? "running" : "ran", "shell command"),
    activityPhrase(counts.other, pending ? "using" : "used", "tool"),
  ].filter((phrase): phrase is string => !!phrase);

  if (phrases.length === 0) return pending ? "Working" : "Finished";
  return phrases
    .map((phrase, index) => (index === 0 ? capitalize(phrase) : phrase))
    .join(", ");
}

function activityPhrase(
  count: number,
  verb: string,
  noun: string,
): string | null {
  if (count === 0) return null;
  return `${verb} ${count} ${noun}${count === 1 ? "" : "s"}`;
}

function capitalize(value: string): string {
  return value ? value[0]!.toUpperCase() + value.slice(1) : value;
}

function activityDetails(call: ToolCallView): string[] {
  if (call.status === "failed") {
    const output = activityOutputLines(call.output).slice(-3);
    if (output.length === 0) return ["Error: Tool failed."];
    return output.map((line, index) => (index === 0 ? `Error: ${line}` : line));
  }

  if (call.name === "run_command" || call.name === "run_package_script") {
    const output = activityOutputLines(call.output);
    if (output.length > 0) return output;
    const command =
      typeof call.args.command === "string"
        ? call.args.command
        : typeof call.args.script === "string"
          ? `npm run ${call.args.script}`
          : call.name;
    return [`$ ${command}`];
  }

  const path = typeof call.args.path === "string" ? call.args.path : null;
  return [path ?? call.name];
}

function activityOutputLines(output: string | null | undefined): string[] {
  return (output ?? "")
    .split(/\r?\n|\r/)
    .map((line) => sanitizeActivityLine(line.trimEnd()))
    .filter(Boolean);
}

function renderToolFailure(
  output: string | null | undefined,
  width: number,
): string[] {
  const details = activityOutputLines(output).slice(-3);
  const message = details.length > 0 ? details.join("\n") : "Tool failed.";
  return new Text(colors.danger(message), 3, 0).render(width);
}

function sanitizeActivityLine(value: string): string {
  return value
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
}

function changedLines(oldText: string, newText: string): ChangedLine[] {
  return diffLines(oldText, newText).flatMap((change) => {
    const kind = change.added ? "added" : change.removed ? "removed" : null;
    if (!kind) return [];
    const value = change.value.endsWith("\n")
      ? change.value.slice(0, -1)
      : change.value;
    return value
      .split("\n")
      .map((text) => ({ kind, text: text.replace(/\r$/, "") }));
  });
}

function renderChangedLines(
  oldText: string,
  newText: string,
  width: number,
): string[] {
  const changes = changedLines(oldText, newText);
  if (changes.length === 0)
    return new Text(colors.faint("no textual changes"), 3, 0).render(width);
  return changes.flatMap((line) => {
    const marker =
      line.kind === "added" ? colors.success("+") : colors.danger("-");
    const content =
      line.kind === "added"
        ? colors.success(line.text || " ")
        : colors.danger(line.text || " ");
    return prefixed(
      new Text(content, 0, 0).render(Math.max(1, width - 5)),
      `   ${marker} `,
      width,
    );
  });
}

function renderStickyQuestion(
  question: QuestionAnchor,
  width: number,
  bodyHeight: number,
): string[] {
  const maximumStickyRows = Math.max(1, Math.min(3, bodyHeight - 1));
  const sticky = question.lines.slice(0, maximumStickyRows);
  if (question.lines.length > sticky.length) {
    sticky[sticky.length - 1] = truncateToWidth(
      `${sticky.at(-1) ?? ""} ${colors.faint("…")}`,
      width,
      "",
    );
  }
  return sticky;
}
