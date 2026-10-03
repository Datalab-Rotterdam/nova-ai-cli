import type { McpServer } from "@agentclientprotocol/sdk";
import { setWorkspaceTrusted } from "../../core/nova-home.js";
import { INTERACTION_MODES } from "../../core/interaction-modes.js";
import {
  allCommands,
  findCommand,
  type SlashCommandContext,
} from "../commands/index.js";
import { readClipboardImage } from "../files/clipboard-image.js";
import { resolveFdPath } from "../files/find-fd.js";
import { listWorkspaceFiles } from "../files/list-workspace-files.js";
import {
  DraftImageAttachments,
  type PromptImageAttachment,
} from "../files/prompt-images.js";
import {
  expandPromptPastes,
  type PromptPasteAttachment,
} from "../files/prompt-pastes.js";
import { WorkspaceAutocompleteProvider } from "../files/workspace-autocomplete.js";
import {
  listSessionPickerItems,
  listSessionsForCwd,
} from "../session/session-picker.js";
import type { SessionRunner } from "../session/session-runner.js";
import type { Store } from "../state/store.js";
import type {
  InteractionMode,
  PermissionMode,
  QuestionRequestView,
  ToolCallView,
  UIState,
} from "../state/types.js";
import {
  QuestionState,
  ScrollState,
  SelectionState,
  ToolInspectorState,
  type SelectionItem,
} from "./dialogs/state.js";
import type { KeyPress } from "./editor/prompt-editor.js";
import { PromptEditor } from "./editor/prompt-editor.js";
import { formatContextUsage, formatImageSize } from "./format.js";
import { bindPromptSubmission } from "./prompt-submission.js";
import { ASSISTANT_MARKER, WORKING_FRAMES } from "./theme.js";
import {
  TranscriptCommitter,
  type TranscriptSnapshot,
} from "./transcript/committer.js";

export type Overlay =
  | { kind: "selection"; title: string; state: SelectionState }
  | { kind: "text"; title: string; content: string; state: ScrollState }
  | { kind: "tools"; state: ToolInspectorState };

export type McpCounts = {
  configured: number;
  connected: number;
  failed: number;
  skills: number;
};

/** Everything the view renders, replaced as a whole on every change. */
export type ViewState = {
  ui: UIState;
  transcript: TranscriptSnapshot;
  overlay: Overlay | null;
  question: QuestionState | null;
  model: string;
  mcp: McpCounts;
  expandedTools: boolean;
  exiting: boolean;
};

export type ControllerIo = {
  /** Raw terminal output that bypasses Ink (title, clearing the screen). */
  write(data: string): void;
};

const CLEAR_SCREEN_AND_SCROLLBACK = "\u001b[2J\u001b[3J\u001b[H";
const EXIT_CONFIRM_MS = 2_000;

/**
 * The TUI's behaviour without React: commands, shortcuts, dialogs, prompt
 * submission and the transcript's scrollback. The Ink view only renders
 * `getView()` and forwards keys.
 */
export class TuiController {
  readonly editor = new PromptEditor();
  private readonly draftImages = new DraftImageAttachments();
  private readonly committer = new TranscriptCommitter();
  private readonly listeners = new Set<() => void>();
  private overlay: Overlay | null = null;
  private question: QuestionState | null = null;
  private expandedTools = false;
  private exiting = false;
  private view: ViewState;
  private lastEpoch = 0;
  private exitArmed = false;
  private exitTimer: ReturnType<typeof setTimeout> | undefined;
  private animationTimer: ReturnType<typeof setInterval> | undefined;
  private windowTitle: string | undefined;
  private windowTitleBusy = false;
  private windowTitleFrame = 0;
  private imagePasteActive = false;
  private stopped = false;
  private readonly unsubscribeStore: () => void;
  private resolveExit: () => void = () => {};
  /** Settles once the user asked to quit; `run` then tears the view down. */
  readonly exitRequested = new Promise<void>((resolve) => {
    this.resolveExit = resolve;
  });

  constructor(
    readonly store: Store<UIState>,
    readonly runner: SessionRunner,
    private readonly io: ControllerIo,
  ) {
    this.view = this.buildView();
    this.lastEpoch = this.view.transcript.epoch;
    this.configureEditor();
    this.unsubscribeStore = store.subscribe(() => this.refresh());
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getView = (): ViewState => this.view;

  start(): void {
    this.syncWindowTitle();
    this.animationTimer = setInterval(() => this.syncWindowTitle(true), 120);
    this.animationTimer.unref?.();
  }

  /** Stops timers and the session; the caller unmounts the view afterwards. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.exitTimer) clearTimeout(this.exitTimer);
    if (this.animationTimer) clearInterval(this.animationTimer);
    this.setWindowTitle(`${ASSISTANT_MARKER} Nova AI`);
    this.unsubscribeStore();
    await this.runner.close().catch(() => {});
  }

  requestExit(): void {
    if (this.exiting) return;
    this.exiting = true;
    this.refresh();
    this.resolveExit();
  }

  // ---------------------------------------------------------------- keys

  /** Shortcuts that work while the prompt has focus; false lets the editor have the key. */
  handlePromptKey(input: string, key: KeyPress): boolean {
    if (key.ctrl && input === "c") {
      this.pressCtrlC();
      return true;
    }
    if (key.escape) {
      if (this.editor.autocomplete) return false;
      if (this.store.getState().busy) {
        this.runner.cancel();
        return true;
      }
      return false;
    }
    if (key.tab && key.shift) {
      this.cycleInteractionMode();
      return true;
    }
    if (key.meta && input === "v") {
      void this.pasteClipboardImage();
      return true;
    }
    if (!key.ctrl) return false;
    switch (input) {
      case "r":
        this.openSessions();
        return true;
      case "p":
        void this.openModels();
        return true;
      case "k":
        this.openPermissionModes();
        return true;
      case "b":
        void this.openBackgroundTasks();
        return true;
      case "o":
        this.toggleToolDetails();
        return true;
      case "t":
        this.openToolInspector();
        return true;
      default:
        return false;
    }
  }

  private pressCtrlC(): void {
    if (this.exitArmed) {
      this.requestExit();
      return;
    }
    if (this.store.getState().busy) this.runner.cancel();
    this.exitArmed = true;
    this.store.setState({ statusLine: "Press Ctrl+C again within 2s to exit." });
    if (this.exitTimer) clearTimeout(this.exitTimer);
    this.exitTimer = setTimeout(() => {
      this.exitArmed = false;
      if (this.store.getState().statusLine?.startsWith("Press Ctrl+C"))
        this.store.setState({ statusLine: null });
    }, EXIT_CONFIRM_MS);
    this.exitTimer.unref?.();
  }

  closeOverlay = (): void => {
    this.overlay = null;
    this.store.setState({ mode: "chat" });
    this.refresh();
  };

  // ------------------------------------------------------------ overlays

  private showOverlay(overlay: Overlay, mode: UIState["mode"] = "chat"): void {
    this.overlay = overlay;
    this.store.setState({ mode });
    this.refresh();
  }

  showText(title: string, content: string): void {
    this.showOverlay({
      kind: "text",
      title,
      content: content || "(no output)",
      state: new ScrollState(this.closeOverlay),
    });
  }

  private showSelection(
    title: string,
    items: SelectionItem[],
    mode: UIState["mode"],
    onSelect: (value: string) => void,
  ): void {
    if (items.length === 0) {
      this.showText(title, "Nothing to show.");
      return;
    }
    const state = new SelectionState(
      items,
      (item) => {
        this.closeOverlay();
        onSelect(item.value);
      },
      this.closeOverlay,
    );
    this.showOverlay({ kind: "selection", title, state }, mode);
  }

  openSessions = (): void => {
    this.showSelection(
      "Sessions · age | prompt | datetime",
      listSessionPickerItems(this.runner.cwd),
      "session-switcher",
      (sessionId) => {
        if (!this.runner.resumeFrom(sessionId))
          this.appendError(`Session not found: ${sessionId}`);
      },
    );
  };

  openModels = async (): Promise<void> => {
    this.showText("Models", "Loading models...");
    try {
      const models = await this.runner.listModels();
      this.showSelection(
        "Models",
        models.map((model) => ({
          value: model.id,
          label: model.id,
          description: model.name ?? undefined,
        })),
        "model-picker",
        (model) => this.setModel(model),
      );
    } catch (error) {
      this.showText("Models", errorMessage(error, "Failed to list models."));
    }
  };

  openPermissionModes = (): void => {
    const modes: Array<{ value: PermissionMode; label: string; description: string }> = [
      { value: "ask", label: "ask", description: "Prompt before tools make changes" },
      { value: "acceptEdits", label: "acceptEdits", description: "Allow file edits automatically" },
      { value: "bypassAll", label: "bypassAll", description: "Allow all tools automatically" },
    ];
    this.showSelection("Permission mode", modes, "permission-picker", (value) =>
      this.setPermissionMode(value as PermissionMode),
    );
  };

  openBackgroundTasks = async (): Promise<void> => {
    try {
      const jobs = await this.runner.listBackgroundJobs();
      this.showSelection(
        "Background shells and agents",
        jobs.map((job) => ({
          value: job.jobId,
          label: `${job.kind}: ${job.title}`,
          description: job.status,
        })),
        "background-tasks",
        (jobId) => {
          void this.runner
            .backgroundOutput(jobId)
            .then((result) =>
              this.showText(
                `${result.job.kind}: ${result.job.title}`,
                `jobId: ${jobId}\nstatus: ${result.job.status}\noutputPath: ${result.outputPath ?? result.job.outputPath ?? ""}\n\n${result.output}${result.truncated ? "\n\n[output truncated]" : ""}`,
              ),
            )
            .catch((error) =>
              this.showText("Background job", errorMessage(error, "Failed to read output.")),
            );
        },
      );
    } catch (error) {
      this.showText("Background jobs", errorMessage(error, "Failed to list background jobs."));
    }
  };

  openToolInspector = (): void => {
    if (this.toolCalls().length === 0) {
      this.showText("Tool calls", "No tool calls yet.");
      return;
    }
    this.showOverlay({
      kind: "tools",
      state: new ToolInspectorState(() => this.toolCalls(), this.closeOverlay),
    });
  };

  openMcpInspector = (): void => {
    const servers = this.runner.configuredMcpServers();
    const connection = this.runner.mcpSessionStatus();
    const configuredNames = new Set(servers.map((server) => server.name));
    const configurationFailures = connection.failures
      .filter((failure) => !configuredNames.has(failure.serverName))
      .map((failure) => `${failure.serverName}\nstatus: failed - ${failure.message}`);
    const rows = [
      ...servers.map((server) => formatMcpServer(server, connection)),
      ...configurationFailures,
    ];
    this.showText(
      "MCP servers",
      rows.length
        ? rows.join("\n\n")
        : "No MCP servers configured for this workspace.\n\nAdd a project .mcp.json or mcpServers to .nova-ai/settings.json; ACP connects them when the session starts.",
    );
  };

  openSkillInspector = (): void => {
    const skills = this.runner.skillSessionStatus();
    this.showText(
      `Skills (${skills.length})`,
      skills.length
        ? skills
            .map((skill) => `${skill.name} [${skill.source}]\n${skill.description}\n${skill.path}`)
            .join("\n\n")
        : "No skills discovered. Add SKILL.md under .agents/skills, .claude/skills, or .codex/skills in the workspace or user profile.",
    );
  };

  openUsageInspector = async (): Promise<void> => {
    this.showText("Context usage", "Calculating context usage...");
    try {
      const usage = await this.runner.refreshContextUsage();
      this.showText("Context usage", formatContextUsage(usage));
    } catch (error) {
      this.showText("Context usage", errorMessage(error, "Failed to calculate context usage."));
    }
  };

  toggleToolDetails(): void {
    this.expandedTools = !this.expandedTools;
    this.store.setState({
      statusLine: this.expandedTools
        ? "Verbose tool details expanded; read/search stay compact."
        : "Verbose tool details collapsed.",
    });
  }

  toolCalls(): ToolCallView[] {
    return this.store
      .getState()
      .messages.flatMap((message) => (message.role === "tool" ? [message.call] : []));
  }

  // ------------------------------------------------------- session state

  setModel(model: string): void {
    this.runner.setModel(model);
    this.store.setState({ statusLine: `Model: ${model}` });
  }

  setPermissionMode(mode: PermissionMode): void {
    this.runner.setPermissionMode(mode);
    this.store.setState({ statusLine: `Permission mode: ${mode}` });
  }

  setInteractionMode(mode: InteractionMode): void {
    this.runner.setInteractionMode(mode);
  }

  cycleInteractionMode(): void {
    const current = INTERACTION_MODES.indexOf(this.runner.interactionMode);
    this.setInteractionMode(INTERACTION_MODES[(current + 1) % INTERACTION_MODES.length]!);
  }

  appendAssistant(text: string): void {
    this.store.setState((state) => ({
      messages: [
        ...state.messages,
        { id: `command-${Date.now()}-${state.messages.length}`, role: "assistant", text, streaming: false },
      ],
    }));
  }

  appendError = (text: string): void => {
    this.store.setState((state) => ({
      messages: [
        ...state.messages,
        { id: `error-${Date.now()}-${state.messages.length}`, role: "error", text },
      ],
    }));
  };

  readonly commandContext: SlashCommandContext = {
    print: (text) => this.appendAssistant(text),
    clear: () => void this.runner.startNewSession(),
    newSession: () => this.runner.startNewSession(),
    exit: () => this.requestExit(),
    resumeSession: (sessionId) => {
      const id = sessionId ?? listSessionsForCwd(this.runner.cwd)[0]?.sessionId;
      return id ? this.runner.resumeFrom(id) : false;
    },
    openSessionSwitcher: this.openSessions,
    openModelPicker: () => void this.openModels(),
    getModel: () => this.runner.model,
    setModel: (model) => this.setModel(model),
    getInteractionMode: () => this.runner.interactionMode,
    setInteractionMode: (mode) => this.setInteractionMode(mode),
    getPermissionMode: () => this.store.getState().permissionMode,
    setPermissionMode: (mode) => this.setPermissionMode(mode),
    openPermissionPicker: this.openPermissionModes,
    trustWorkspace: () => {
      setWorkspaceTrusted(this.runner.cwd, true);
      return "Workspace trusted: its allow rules apply now; MCP servers it declares start with the next session (/clear).";
    },
    openToolInspector: this.openToolInspector,
    openMcpInspector: this.openMcpInspector,
    openSkillInspector: this.openSkillInspector,
    openUsageInspector: this.openUsageInspector,
    steerMessage: (message) => this.runner.steer(message),
    queuedMessages: () => this.runner.queuedMessages(),
    clearQueuedMessages: () => this.runner.clearQueuedMessages(),
    compactContext: () => this.runner.compactContext(),
    rewind: (turns) => this.runner.rewind(turns),
    listModels: () => this.runner.listModels(),
    startBackgroundShell: (command) => this.runner.startBackgroundShell(command),
    startBackgroundAgent: (prompt) => this.runner.startBackgroundAgent(prompt),
    listBackgroundJobs: (kind) => this.runner.listBackgroundJobs(kind),
    backgroundOutput: (jobId) => this.runner.backgroundOutput(jobId),
    killBackgroundJob: (jobId) => this.runner.killBackgroundJob(jobId),
    releaseBackgroundJob: (jobId) => this.runner.releaseBackgroundJob(jobId),
  };

  // ------------------------------------------------------------ prompt

  submit = async (
    text: string,
    images: PromptImageAttachment[] = [],
    pastes: PromptPasteAttachment[] = [],
  ): Promise<void> => {
    const value = text.trim();
    if (!value) return;
    this.editor.addToHistory(value);
    this.store.setState((state) => ({
      inputHistory: [...state.inputHistory, value],
      statusLine: null,
    }));
    if (!value.startsWith("/")) {
      await this.runner.submit(value, images, pastes);
      return;
    }
    const commandValue = expandPromptPastes(value, pastes);
    const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(commandValue);
    const name = match?.[1] ?? "";
    const command = findCommand(name);
    if (!command) {
      this.appendError(`Unknown command: /${name}`);
      return;
    }
    try {
      await command.run(this.commandContext, match?.[2] ?? "");
    } catch (error) {
      this.appendError(`Command /${name} failed: ${errorMessage(error, "Unknown error.")}`);
      this.store.setState({ statusLine: `Command /${name} failed.` });
    }
  };

  private async pasteClipboardImage(): Promise<void> {
    if (this.imagePasteActive) return;
    this.imagePasteActive = true;
    const model = this.runner.model;
    this.store.setState({ statusLine: "Reading clipboard image..." });
    try {
      if (!(await this.runner.supportsImageInput(model))) {
        this.store.setState({ statusLine: `Model ${model} does not support image input.` });
        return;
      }
      if (this.runner.model !== model && !(await this.runner.supportsImageInput())) {
        this.store.setState({
          statusLine: `Model ${this.runner.model} does not support image input.`,
        });
        return;
      }
      const attachment = this.draftImages.add(await readClipboardImage());
      this.editor.insertTextAtCursor(attachment.marker);
      this.store.setState({
        statusLine: `Attached ${attachment.marker} (${formatImageSize(attachment.byteLength)}).`,
      });
    } catch (error) {
      this.store.setState({
        statusLine: `Image paste failed: ${errorMessage(error, "Unknown error.")}`,
      });
    } finally {
      this.imagePasteActive = false;
    }
  }

  private configureEditor(): void {
    const { editor, runner, draftImages } = this;
    editor.setQueuedMessageProvider(() => runner.queuedMessageEntries());
    editor.onQueuedMessageEditStart = (id) => {
      runner.beginQueuedMessageEdit(id);
    };
    editor.onQueuedMessageEditFinish = (id, text) => {
      runner.finishQueuedMessageEdit(
        id,
        text,
        draftImages.referencedBy(text),
        editor.referencedPastes(text),
      );
      draftImages.clear();
    };
    editor.onChange = (text) => {
      const id = editor.editingQueuedMessage();
      if (id) runner.updateQueuedMessage(id, text);
    };
    const fdPath = resolveFdPath();
    editor.setAutocompleteProvider(
      new WorkspaceAutocompleteProvider(
        allCommands().map((command) => ({
          name: command.name,
          description: command.description,
        })),
        runner.cwd,
        // fd (when available) walks the tree itself and respects .gitignore;
        // the pre-scanned list is only its fallback.
        fdPath ? [] : listWorkspaceFiles(runner.cwd, 10_000),
        fdPath,
      ),
    );
    bindPromptSubmission({
      editor,
      draftImages,
      runner,
      store: this.store,
      submit: this.submit,
      appendError: this.appendError,
    });
  }

  // -------------------------------------------------------------- view

  private refresh(): void {
    this.syncWindowTitle();
    this.view = this.buildView();
    if (this.view.transcript.epoch !== this.lastEpoch) {
      this.lastEpoch = this.view.transcript.epoch;
      // The printed scrollback no longer matches the transcript (another
      // session, a rewind, verbose tools): clear it and print it again.
      this.io.write(CLEAR_SCREEN_AND_SCROLLBACK);
    }
    for (const listener of this.listeners) listener();
  }

  private buildView(): ViewState {
    const ui = this.store.getState();
    return {
      ui,
      transcript: this.committer.sync(ui, this.expandedTools),
      overlay: this.overlay,
      question: this.questionState(ui.pendingQuestion),
      model: this.runner.model,
      mcp: mcpCounts(this.runner),
      expandedTools: this.expandedTools,
      exiting: this.exiting,
    };
  }

  private questionState(pending: QuestionRequestView | null): QuestionState | null {
    if (!pending) {
      this.question = null;
      return null;
    }
    if (this.question?.pending.id !== pending.id) {
      this.question = new QuestionState(pending, () => {});
    }
    return this.question;
  }

  private syncWindowTitle(advance = false): void {
    const busy = this.store.getState().busy;
    if (busy !== this.windowTitleBusy) {
      this.windowTitleBusy = busy;
      this.windowTitleFrame = 0;
    } else if (busy && advance) {
      this.windowTitleFrame = (this.windowTitleFrame + 1) % WORKING_FRAMES.length;
    }
    const marker = busy ? WORKING_FRAMES[this.windowTitleFrame]! : ASSISTANT_MARKER;
    this.setWindowTitle(`${marker} ${busy ? "Nova-AI" : "Nova AI"}`);
  }

  private setWindowTitle(title: string): void {
    if (title === this.windowTitle) return;
    this.windowTitle = title;
    this.io.write(`\u001b]0;${title}\u0007`);
  }
}

function formatMcpServer(
  server: McpServer,
  status: ReturnType<SessionRunner["mcpSessionStatus"]>,
): string {
  const type = "type" in server ? server.type : "stdio";
  const lines = [`${server.name} [${type}]`];
  if ("url" in server) lines.push(`url: ${server.url}`);
  if ("command" in server) {
    lines.push(`command: ${server.command}`);
    if (server.args.length) lines.push(`args: ${server.args.join(" ")}`);
    if (server.env.length)
      lines.push(`env: ${server.env.map((entry) => entry.name).join(", ")} (values hidden)`);
  }
  const failure = status.failures.find((item) => item.serverName === server.name);
  lines.push(
    failure
      ? `status: failed - ${failure.message}`
      : status.connected.includes(server.name)
        ? "status: connected"
        : "status: configured; connection starts with the ACP session",
  );
  return lines.join("\n");
}

export function mcpCounts(runner: SessionRunner): McpCounts {
  const status = runner.mcpSessionStatus();
  return {
    configured: status.configured.length,
    connected: status.connected.length,
    failed: status.failures.length,
    skills: runner.skillSessionStatus().length,
  };
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
