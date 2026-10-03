import type {
  BackgroundJobView,
  PlanEntryView,
  ToolCallView,
  UIMessage,
  UIState,
} from "../../state/types.js";
import { isActivityTool } from "../format.js";

export type TranscriptBlock =
  | { key: string; kind: "header"; cwd: string }
  | { key: string; kind: "user"; text: string }
  | { key: string; kind: "queued"; text: string; queued: "steer" | "followup" }
  | {
      key: string;
      kind: "assistant";
      text: string;
      /** The first part of a message carries the assistant marker. */
      first: boolean;
      streaming: boolean;
    }
  | { key: string; kind: "error"; text: string }
  | { key: string; kind: "tool"; call: ToolCallView; expanded: boolean }
  | { key: string; kind: "activity"; calls: ToolCallView[] }
  | { key: string; kind: "background"; job: BackgroundJobView; expanded: boolean }
  | { key: string; kind: "plan"; entries: PlanEntryView[] };

export type TranscriptSnapshot = {
  /** Changes when the printed scrollback no longer matches and must be redrawn. */
  epoch: number;
  /** Append-only within an epoch: rendered once into the terminal's scrollback. */
  committed: readonly TranscriptBlock[];
  /** Still changing; redrawn on every frame below the scrollback. */
  live: TranscriptBlock[];
};

const FINAL_JOB_STATUSES = new Set(["completed", "failed", "killed", "released"]);

/**
 * Decides which parts of the transcript are final. Ink prints final blocks
 * once (`<Static>`), so the terminal keeps them as ordinary scrollback that
 * can be scrolled, searched and copied; everything else is the live area.
 *
 * Final blocks always form a prefix of the transcript. Anything that breaks
 * that prefix (another session, a rewind, toggling verbose tool output)
 * starts a new epoch: the view clears the screen and prints everything again.
 */
export class TranscriptCommitter {
  private epoch = 0;
  private committed: TranscriptBlock[] = [];
  private committedView: readonly TranscriptBlock[] = [];
  /** Ids of the messages whose blocks are all committed, in order. */
  private committedIds: string[] = [];
  /** How much of a streaming assistant message is already committed. */
  private partial: { id: string; offset: number } | null = null;
  private readonly backgroundStatus = new Map<string, string>();
  private sessionId: string | null = null;
  private expanded = false;
  private planSignature: string | null = null;
  private snapshot: TranscriptSnapshot | null = null;
  private lastState: UIState | null = null;
  private redrawRequested = false;

  /** The next sync starts a new epoch, e.g. after the terminal width changed. */
  requestRedraw(): void {
    this.redrawRequested = true;
    this.lastState = null;
  }

  sync(state: UIState, expanded: boolean): TranscriptSnapshot {
    if (this.snapshot && state === this.lastState && expanded === this.expanded)
      return this.snapshot;
    this.lastState = state;

    if (
      this.redrawRequested ||
      state.sessionId !== this.sessionId ||
      expanded !== this.expanded ||
      !this.prefixIntact(state.messages)
    ) {
      this.startEpoch(state, expanded);
    }

    const messages = state.messages;
    this.commitBackgroundChanges(messages);

    const live: TranscriptBlock[] = [];
    let committing = true;
    const emit = (block: TranscriptBlock, final: boolean, consumed: string[]) => {
      if (committing && final) {
        this.committed.push(block);
        this.committedIds.push(...consumed);
      } else {
        committing = false;
        live.push(block);
      }
    };

    let index = this.committedIds.length;
    while (index < messages.length) {
      const message = messages[index]!;

      if (message.role === "tool" && !expanded && isActivityTool(message.call)) {
        const calls: ToolCallView[] = [];
        const ids: string[] = [];
        let end = index;
        while (end < messages.length) {
          const next = messages[end]!;
          if (next.role !== "tool" || !isActivityTool(next.call)) break;
          calls.push(next.call);
          ids.push(next.id);
          end++;
        }
        const following = messages[end];
        // A group stays open while more tools of the same turn may join it.
        const closed =
          calls.every((call) => call.status !== "pending") &&
          ((following !== undefined && !isQueued(following)) || !state.busy);
        emit({ key: `activity:${message.id}`, kind: "activity", calls }, closed, ids);
        index = end;
        continue;
      }

      switch (message.role) {
        case "user":
          if (message.queued) {
            emit(
              { key: message.id, kind: "queued", text: message.text, queued: message.queued },
              false,
              [],
            );
          } else {
            emit({ key: message.id, kind: "user", text: message.text }, true, [message.id]);
          }
          break;
        case "error":
          emit({ key: message.id, kind: "error", text: message.text }, true, [message.id]);
          break;
        case "tool":
          emit(
            { key: message.id, kind: "tool", call: message.call, expanded },
            message.call.status !== "pending",
            [message.id],
          );
          break;
        case "background":
          if (committing) this.backgroundStatus.set(message.job.jobId, message.job.status);
          emit(
            { key: message.id, kind: "background", job: message.job, expanded },
            true,
            [message.id],
          );
          break;
        case "assistant":
          this.emitAssistant(message, committing, emit);
          if (message.streaming) committing = false;
          break;
      }
      index++;
    }

    this.emitPlan(state, committing, live);

    // <Static> notices new items by array identity, so every growth needs a
    // fresh array; unchanged scrollback keeps its reference.
    if (this.committedView.length !== this.committed.length)
      this.committedView = this.committed.slice();
    this.snapshot = { epoch: this.epoch, committed: this.committedView, live };
    return this.snapshot;
  }

  private emitAssistant(
    message: Extract<UIMessage, { role: "assistant" }>,
    committing: boolean,
    emit: (block: TranscriptBlock, final: boolean, consumed: string[]) => void,
  ): void {
    let offset = this.partial?.id === message.id ? this.partial.offset : 0;
    const block = (text: string, streaming: boolean) =>
      ({
        key: `${message.id}:${offset}`,
        kind: "assistant",
        text,
        first: offset === 0,
        streaming,
      }) as const;

    if (!message.streaming) {
      const rest = message.text.slice(offset);
      if (committing && this.partial?.id === message.id) this.partial = null;
      if (rest.trim()) emit(block(rest, false), true, [message.id]);
      else if (committing) this.committedIds.push(message.id);
      return;
    }

    if (committing) {
      // Completed paragraphs of a long answer go to the scrollback while the
      // rest still streams, so the live area stays small.
      const split = safeSplitOffset(message.text, offset);
      if (split > offset && message.text.slice(offset, split).trim()) {
        emit(block(message.text.slice(offset, split), false), true, []);
        offset = split;
        this.partial = { id: message.id, offset };
      }
    }
    const rest = message.text.slice(offset);
    emit(block(rest, true), false, []);
  }

  private emitPlan(state: UIState, committing: boolean, live: TranscriptBlock[]): void {
    if (state.plan.length === 0) return;
    const signature = JSON.stringify(state.plan);
    if (signature === this.planSignature) return;
    const block: TranscriptBlock = {
      key: `plan:${this.committed.length}:${signature.length}`,
      kind: "plan",
      entries: state.plan,
    };
    // While the turn runs the plan updates in place; when it ends, the last
    // version becomes part of the scrollback.
    if (committing && !state.busy) {
      this.committed.push(block);
      this.planSignature = signature;
    } else {
      live.push(block);
    }
  }

  /** A background job that finishes after it was printed gets a new line. */
  private commitBackgroundChanges(messages: UIMessage[]): void {
    for (let index = 0; index < this.committedIds.length; index++) {
      const message = messages[index];
      if (message?.role !== "background") continue;
      const { job } = message;
      const previous = this.backgroundStatus.get(job.jobId);
      if (previous === job.status) continue;
      this.backgroundStatus.set(job.jobId, job.status);
      if (!FINAL_JOB_STATUSES.has(job.status)) continue;
      this.committed.push({
        key: `${message.id}:${job.status}`,
        kind: "background",
        job,
        expanded: this.expanded,
      });
    }
  }

  private prefixIntact(messages: UIMessage[]): boolean {
    if (messages.length < this.committedIds.length) return false;
    for (let index = 0; index < this.committedIds.length; index++) {
      if (messages[index]!.id !== this.committedIds[index]) return false;
    }
    if (this.partial) {
      const message = messages[this.committedIds.length];
      if (
        message?.id !== this.partial.id ||
        message.role !== "assistant" ||
        message.text.length < this.partial.offset
      )
        return false;
    }
    return true;
  }

  private startEpoch(state: UIState, expanded: boolean): void {
    this.redrawRequested = false;
    this.epoch++;
    this.sessionId = state.sessionId;
    this.expanded = expanded;
    this.committed = [{ key: `header:${this.epoch}`, kind: "header", cwd: state.cwd }];
    this.committedView = [];
    this.committedIds = [];
    this.partial = null;
    this.backgroundStatus.clear();
    this.planSignature = null;
  }
}

function isQueued(message: UIMessage): boolean {
  return message.role === "user" && message.queued !== undefined;
}

/**
 * The end of the last complete Markdown block before `text.length`: just
 * after a blank line that is not inside a fenced code block. Returns `from`
 * when there is none.
 */
export function safeSplitOffset(text: string, from: number): number {
  let inFence = false;
  let fenceMarker = "";
  let lineStart = 0;
  let split = from;
  let previousBlank = false;
  while (lineStart <= text.length) {
    const newline = text.indexOf("\n", lineStart);
    // The last line may still be growing; it never ends a block.
    if (newline === -1) break;
    const line = text.slice(lineStart, newline);
    const fence = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (!inFence) {
        inFence = true;
        fenceMarker = fence[1]![0]!.repeat(fence[1]!.length);
      } else if (line.trim().startsWith(fenceMarker)) {
        inFence = false;
      }
    }
    const blank = line.trim() === "";
    const next = newline + 1;
    if (!inFence && blank && !previousBlank && next > from && lineStart > from) {
      split = next;
    }
    previousBlank = blank;
    lineStart = next;
  }
  return split;
}
