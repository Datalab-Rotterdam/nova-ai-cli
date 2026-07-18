import type { McpServer } from "@agentclientprotocol/sdk";
import {
  Key,
  TUI,
  matchesKey,
  type OverlayHandle,
} from "@earendil-works/pi-tui";
import type { StoredCredentials } from "../../acp/credentials.js";
import type { ContextUsage } from "../../core/context-usage.js";
import { INTERACTION_MODES } from "../../core/interaction-modes.js";
import {
  allCommands,
  findCommand,
  type SlashCommandContext,
} from "../commands/index.js";
import { readClipboardImage } from "../files/clipboard-image.js";
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
import { SessionRunner } from "../session/session-runner.js";
import {
  setPermissionMode as persistPermissionMode,
  readWorkspaceSettings,
} from "../settings/workspace-settings.js";
import { createStore } from "../state/store.js";
import type {
  InteractionMode,
  PermissionMode,
  UIState,
} from "../state/types.js";
import { checkForUpdate } from "../update-check.js";
import {
  BorderedWindow,
  formatTokenCount,
  formatToolCallDetails,
  FullscreenLayout,
  mouseWheelDelta,
  PermissionDialog,
  QuestionDialog,
  ScrollPanel,
  SelectionDialog,
  type SelectionItem,
  StatusView,
  TranscriptView,
} from "./components.js";
import { FullscreenProcessTerminal } from "./fullscreen-terminal.js";
import { PromptEditor } from "./prompt-editor.js";
import { bindPromptSubmission } from "./prompt-submission.js";
import { colors, editorTheme, selectListTheme } from "./theme.js";

export async function runPiTui(
  credentials: StoredCredentials,
  cwd: string,
  args: string[],
): Promise<void> {
  const workspaceSettings = readWorkspaceSettings(cwd);
  const store = createStore<UIState>({
    messages: [],
    pendingPermission: null,
    pendingQuestion: null,
    inputHistory: [],
    busy: false,
    mode: "chat",
    permissionMode: workspaceSettings.permissionMode ?? "ask",
    interactionMode: "agent",
    sessionId: "",
    cwd,
    statusLine: null,
    queuedCount: 0,
    contextUsage: null,
    updateAvailable: null,
  });
  const runner = new SessionRunner(store, credentials, cwd);
  const resumeIndex = args.indexOf("--resume");
  const resumeId = resumeIndex >= 0 ? args[resumeIndex + 1] : undefined;
  if (resumeId) runner.resumeFrom(resumeId);
  else store.setState({ sessionId: runner.sessionId });

  const terminal = new FullscreenProcessTerminal();
  const tui = new TUI(terminal, true);
  const transcript = new TranscriptView(store);
  const status = new StatusView(store, runner.model, mcpCounts(runner));
  const editor = new PromptEditor(tui, editorTheme, {
    autocompleteMaxVisible: 8,
  });
  const draftImages = new DraftImageAttachments();
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
  editor.setAutocompleteProvider(
    new WorkspaceAutocompleteProvider(
      allCommands().map((command) => ({
        name: command.name,
        description: command.description,
      })),
      cwd,
      listWorkspaceFiles(cwd, 10_000),
    ),
  );

  let activeOverlay: OverlayHandle | null = null;
  let activePermissionId: string | null = null;
  let activeQuestionId: string | null = null;
  let exitArmed = false;
  let exitTimer: ReturnType<typeof setTimeout> | undefined;
  let animationTimer: ReturnType<typeof setInterval> | undefined;
  let imagePasteActive = false;
  let stopped = false;
  let resolveExit: () => void = () => {};
  const exited = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });

  const requestRender = () => tui.requestRender();
  const layout = new FullscreenLayout(
    transcript,
    status,
    editor,
    () => terminal.rows,
    requestRender,
  );
  tui.addChild(layout);
  tui.setFocus(editor);

  const closeOverlay = () => {
    activeOverlay?.hide();
    activeOverlay = null;
    layout.hideFullscreen();
    activePermissionId = null;
    activeQuestionId = null;
    store.setState({ mode: "chat" });
    tui.setFocus(editor);
    tui.requestRender(true);
  };

  const showOverlay = (
    component: Parameters<TUI["showOverlay"]>[0],
    mode: UIState["mode"] = "chat",
    width: number | `${number}%` = "80%",
  ) => {
    activeOverlay?.hide();
    layout.hideFullscreen();
    store.setState({ mode });
    const surface = new BorderedWindow(component, () =>
      Math.max(3, terminal.rows - 2),
    );
    activeOverlay = tui.showOverlay(surface, {
      width,
      maxHeight: "100%",
      anchor: "center",
      margin: 1,
    });
    requestRender();
  };

  const showText = (title: string, content: string) => {
    const panel = new ScrollPanel(
      title,
      content || "(no output)",
      () => Math.max(4, terminal.rows - 4),
      requestRender,
      closeOverlay,
    );
    showOverlay(panel);
  };

  const showSelection = (
    title: string,
    items: SelectionItem[],
    mode: UIState["mode"],
    onSelect: (value: string) => void,
    bordered = false,
  ) => {
    if (items.length === 0) {
      showText(title, "Nothing to show.");
      return;
    }
    const dialog = new SelectionDialog(
      title,
      items,
      selectListTheme,
      () => Math.max(1, terminal.rows - (bordered ? 6 : 4)),
      () => tui.requestRender(true),
      (item) => {
        closeOverlay();
        onSelect(item.value);
      },
      closeOverlay,
    );
    activeOverlay?.hide();
    activeOverlay = null;
    layout.hideFullscreen();
    store.setState({ mode });
    const surface = bordered ? new BorderedWindow(dialog) : dialog;
    layout.showFullscreen(surface);
    tui.setFocus(surface);
    tui.requestRender(true);
  };

  const openSessions = () => {
    showSelection(
      "Sessions · age | prompt | datetime",
      listSessionPickerItems(runner.cwd),
      "session-switcher",
      (sessionId) => {
        if (!runner.resumeFrom(sessionId))
          appendError(`Session not found: ${sessionId}`);
      },
    );
  };

  const openModels = async () => {
    showText("Models", "Loading models...");
    try {
      const models = await runner.listModels();
      showSelection(
        "Models",
        models.map((model) => ({
          value: model.id,
          label: model.id,
          description: model.name ?? undefined,
        })),
        "model-picker",
        (model) => {
          runner.setModel(model);
          store.setState({ statusLine: `Model: ${model}` });
        },
      );
    } catch (error) {
      showText(
        "Models",
        error instanceof Error ? error.message : "Failed to list models.",
      );
    }
  };

  const setInteractionMode = (mode: InteractionMode) => {
    runner.setInteractionMode(mode);
  };

  const cycleInteractionMode = () => {
    const current = INTERACTION_MODES.indexOf(runner.interactionMode);
    setInteractionMode(
      INTERACTION_MODES[(current + 1) % INTERACTION_MODES.length]!,
    );
  };

  const setPermissionMode = (mode: PermissionMode) => {
    persistPermissionMode(runner.cwd, mode);
    store.setState({
      permissionMode: mode,
      statusLine: `Permission mode: ${mode}`,
    });
  };

  const openPermissionModes = () => {
    const modes: Array<{
      value: PermissionMode;
      label: string;
      description: string;
    }> = [
      {
        value: "ask",
        label: "ask",
        description: "Prompt before tools make changes",
      },
      {
        value: "acceptEdits",
        label: "acceptEdits",
        description: "Allow file edits automatically",
      },
      {
        value: "bypassAll",
        label: "bypassAll",
        description: "Allow all tools automatically",
      },
    ];
    showSelection("Permission mode", modes, "permission-picker", (value) =>
      setPermissionMode(value as PermissionMode),
    );
  };

  const openBackgroundTasks = async () => {
    try {
      const jobs = await runner.listBackgroundJobs();
      showSelection(
        "Background shells and agents",
        jobs.map((job) => ({
          value: job.jobId,
          label: `${job.kind}: ${job.title}`,
          description: job.status,
        })),
        "background-tasks",
        (jobId) => {
          void runner
            .backgroundOutput(jobId)
            .then((result) => {
              showText(
                `${result.job.kind}: ${result.job.title}`,
                `jobId: ${jobId}\nstatus: ${result.job.status}\noutputPath: ${result.outputPath ?? result.job.outputPath ?? ""}\n\n${result.output}${result.truncated ? "\n\n[output truncated]" : ""}`,
              );
            })
            .catch((error) =>
              showText(
                "Background job",
                error instanceof Error
                  ? error.message
                  : "Failed to read output.",
              ),
            );
        },
      );
    } catch (error) {
      showText(
        "Background jobs",
        error instanceof Error
          ? error.message
          : "Failed to list background jobs.",
      );
    }
  };

  const openToolInspector = () => {
    const tools = transcript.toolCalls();
    showSelection(
      "Tool calls",
      tools.map((call) => ({
        value: call.toolCallId,
        label: call.name,
        description: `${call.status} · ${call.kind}${call.mutating ? " · changes" : ""}`,
      })),
      "chat",
      (toolCallId) => {
        const call = transcript
          .toolCalls()
          .find((item) => item.toolCallId === toolCallId);
        if (call) showText(`Tool: ${call.name}`, formatToolCallDetails(call));
      },
      true,
    );
  };

  const openMcpInspector = () => {
    const servers = runner.configuredMcpServers();
    const connection = runner.mcpSessionStatus();
    const configuredNames = new Set(servers.map((server) => server.name));
    const configurationFailures = connection.failures
      .filter((failure) => !configuredNames.has(failure.serverName))
      .map(
        (failure) =>
          `${failure.serverName}\nstatus: failed - ${failure.message}`,
      );
    const rows = [
      ...servers.map((server) => formatMcpServer(server, connection)),
      ...configurationFailures,
    ];
    showText(
      "MCP servers",
      rows.length
        ? rows.join("\n\n")
        : "No MCP servers configured for this workspace.\n\nAdd a project .mcp.json or mcpServers to .nova-ai/settings.json; ACP connects them when the session starts.",
    );
  };

  const openSkillInspector = () => {
    const skills = runner.skillSessionStatus();
    showText(
      `Skills (${skills.length})`,
      skills.length
        ? skills
            .map(
              (skill) =>
                `${skill.name} [${skill.source}]\n${skill.description}\n${skill.path}`,
            )
            .join("\n\n")
        : "No skills discovered. Add SKILL.md under .agents/skills, .claude/skills, or .codex/skills in the workspace or user profile.",
    );
  };

  const openUsageInspector = async () => {
    showText("Context usage", "Calculating context usage...");
    try {
      const usage = await runner.refreshContextUsage();
      showText("Context usage", formatContextUsage(usage));
    } catch (error) {
      showText(
        "Context usage",
        error instanceof Error
          ? error.message
          : "Failed to calculate context usage.",
      );
    }
  };

  const appendAssistant = (text: string) => {
    store.setState((state) => ({
      messages: [
        ...state.messages,
        {
          id: `command-${Date.now()}-${state.messages.length}`,
          role: "assistant",
          text,
          streaming: false,
        },
      ],
    }));
  };

  const appendError = (text: string) => {
    store.setState((state) => ({
      messages: [
        ...state.messages,
        {
          id: `error-${Date.now()}-${state.messages.length}`,
          role: "error",
          text,
        },
      ],
    }));
  };

  const finishExit = async () => {
    if (stopped) return;
    stopped = true;
    if (exitTimer) clearTimeout(exitTimer);
    if (animationTimer) clearInterval(animationTimer);
    unsubscribeStore();
    process.off("SIGTERM", signalExit);
    await runner.close().catch(() => {});
    tui.stop();
    process.stdout.write(
      `Resume this session with: nova-ai --resume ${runner.sessionId}\n`,
    );
    resolveExit();
  };

  const commandContext: SlashCommandContext = {
    print: appendAssistant,
    clear: () => void runner.startNewSession(),
    newSession: () => runner.startNewSession(),
    exit: () => void finishExit(),
    resumeSession: (sessionId) => {
      const id = sessionId ?? listSessionsForCwd(runner.cwd)[0]?.sessionId;
      return id ? runner.resumeFrom(id) : false;
    },
    openSessionSwitcher: openSessions,
    openModelPicker: () => void openModels(),
    getModel: () => runner.model,
    setModel: (model) => {
      runner.setModel(model);
      store.setState({ statusLine: `Model: ${model}` });
    },
    getInteractionMode: () => runner.interactionMode,
    setInteractionMode,
    getPermissionMode: () => store.getState().permissionMode,
    setPermissionMode,
    openPermissionPicker: openPermissionModes,
    openToolInspector,
    openMcpInspector,
    openSkillInspector,
    openUsageInspector,
    queueMessage: (message) => void runner.submit(message),
    steerMessage: (message) => runner.steer(message),
    queuedMessages: () => runner.queuedMessages(),
    clearQueuedMessages: () => runner.clearQueuedMessages(),
    compactContext: () => runner.compactContext(),
    listModels: () => runner.listModels(),
    startBackgroundShell: (command) => runner.startBackgroundShell(command),
    startBackgroundAgent: (prompt) => runner.startBackgroundAgent(prompt),
    listBackgroundJobs: (kind) => runner.listBackgroundJobs(kind),
    backgroundOutput: (jobId) => runner.backgroundOutput(jobId),
    killBackgroundJob: (jobId) => runner.killBackgroundJob(jobId),
    releaseBackgroundJob: (jobId) => runner.releaseBackgroundJob(jobId),
  };

  const pasteClipboardImage = async (): Promise<void> => {
    if (imagePasteActive) return;
    imagePasteActive = true;
    const model = runner.model;
    store.setState({ statusLine: "Reading clipboard image..." });
    try {
      if (!(await runner.supportsImageInput(model))) {
        store.setState({
          statusLine: `Model ${model} does not support image input.`,
        });
        return;
      }
      if (runner.model !== model && !(await runner.supportsImageInput())) {
        store.setState({
          statusLine: `Model ${runner.model} does not support image input.`,
        });
        return;
      }
      const attachment = draftImages.add(await readClipboardImage());
      editor.insertTextAtCursor(attachment.marker);
      store.setState({
        statusLine: `Attached ${attachment.marker} (${formatImageSize(attachment.byteLength)}).`,
      });
      requestRender();
    } catch (error) {
      store.setState({
        statusLine: `Image paste failed: ${error instanceof Error ? error.message : "Unknown error."}`,
      });
    } finally {
      imagePasteActive = false;
    }
  };

  const submit = async (
    text: string,
    images: PromptImageAttachment[] = [],
    pastes: PromptPasteAttachment[] = [],
  ): Promise<void> => {
    const value = text.trim();
    if (!value) return;
    layout.scrollToBottom();
    editor.addToHistory(value);
    store.setState((state) => ({
      inputHistory: [...state.inputHistory, value],
      statusLine: null,
    }));
    if (!value.startsWith("/")) {
      await runner.submit(value, images, pastes);
      return;
    }
    const commandValue = expandPromptPastes(value, pastes);
    const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(commandValue);
    const name = match?.[1] ?? "";
    const command = findCommand(name);
    if (!command) {
      appendError(`Unknown command: /${name}`);
      return;
    }
    try {
      await command.run(commandContext, match?.[2] ?? "");
    } catch (error) {
      appendError(
        `Command /${name} failed: ${error instanceof Error ? error.message : "Unknown error."}`,
      );
      store.setState({ statusLine: `Command /${name} failed.` });
    }
  };

  bindPromptSubmission({
    editor,
    draftImages,
    runner,
    store,
    submit,
    appendError,
  });

  const unsubscribeInput = tui.addInputListener((data) => {
    if (tui.hasOverlay() || layout.hasFullscreen()) return;
    if (matchesKey(data, Key.alt("v"))) {
      void pasteClipboardImage();
      return { consume: true };
    }
    const wheel = mouseWheelDelta(data);
    if (wheel !== null) {
      if (wheel < 0) layout.scrollOlder(3);
      else layout.scrollNewer(3);
      return { consume: true };
    }
    if (matchesKey(data, Key.shift(Key.pageUp))) {
      layout.scrollOlder(layout.pageRows());
      return { consume: true };
    }
    if (matchesKey(data, Key.shift(Key.pageDown))) {
      layout.scrollNewer(layout.pageRows());
      return { consume: true };
    }
    if (matchesKey(data, Key.ctrl(Key.home))) {
      layout.scrollToTop();
      return { consume: true };
    }
    if (matchesKey(data, Key.ctrl(Key.end))) {
      layout.scrollToBottom();
      return { consume: true };
    }
    if (matchesKey(data, Key.ctrl("c"))) {
      if (exitArmed) {
        void finishExit();
        return { consume: true };
      }
      if (store.getState().busy) runner.cancel();
      exitArmed = true;
      store.setState({ statusLine: "Press Ctrl+C again within 2s to exit." });
      if (exitTimer) clearTimeout(exitTimer);
      exitTimer = setTimeout(() => {
        exitArmed = false;
        if (store.getState().statusLine?.startsWith("Press Ctrl+C"))
          store.setState({ statusLine: null });
      }, 2_000);
      return { consume: true };
    }
    if (matchesKey(data, Key.escape) && store.getState().busy) {
      runner.cancel();
      return { consume: true };
    }
    if (matchesKey(data, Key.shift(Key.tab))) {
      cycleInteractionMode();
      return { consume: true };
    }
    if (matchesKey(data, Key.ctrl("r"))) {
      openSessions();
      return { consume: true };
    }
    if (matchesKey(data, Key.ctrl("p"))) {
      void openModels();
      return { consume: true };
    }
    if (matchesKey(data, Key.ctrl("k"))) {
      openPermissionModes();
      return { consume: true };
    }
    if (matchesKey(data, Key.ctrl("b"))) {
      void openBackgroundTasks();
      return { consume: true };
    }
    if (matchesKey(data, Key.ctrl("o"))) {
      transcript.toggleToolDetails();
      layout.scrollToBottom();
      store.setState({
        statusLine: transcript.areToolDetailsExpanded()
          ? "Verbose tool details expanded; read/search stay compact."
          : "Verbose tool details collapsed.",
      });
      return { consume: true };
    }
    if (matchesKey(data, Key.ctrl("t"))) {
      openToolInspector();
      return { consume: true };
    }
    return;
  });

  const unsubscribeStore = store.subscribe(() => {
    const state = store.getState();
    transcript.sync();
    status.update(state, runner.model, mcpCounts(runner));
    editor.borderColor = state.busy ? colors.warning : colors.primary;

    const question = state.pendingQuestion;
    const permission = state.pendingPermission;
    if (question && question.id !== activeQuestionId) {
      activeQuestionId = question.id;
      const dialog = new QuestionDialog(question, requestRender, closeOverlay);
      showOverlay(dialog, "chat", "80%");
    } else if (
      !question &&
      permission &&
      permission.toolCallId !== activePermissionId
    ) {
      activePermissionId = permission.toolCallId;
      const dialog = new PermissionDialog(permission, closeOverlay);
      showOverlay(dialog, "chat", "80%");
    } else if (
      !question &&
      !permission &&
      (activePermissionId || activeQuestionId)
    ) {
      closeOverlay();
    }
    requestRender();
  });

  const signalExit = () => {
    void finishExit();
  };
  process.once("SIGTERM", signalExit);

  tui.start();
  void checkForUpdate().then((updateAvailable) => {
    if (!stopped && updateAvailable) store.setState({ updateAvailable });
  });
  animationTimer = setInterval(() => {
    if (
      !tui.hasOverlay() &&
      !layout.hasFullscreen() &&
      transcript.advanceAnimation()
    )
      requestRender();
  }, 120);
  animationTimer.unref?.();
  requestRender();
  await exited;
  unsubscribeInput();
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
      lines.push(
        `env: ${server.env.map((entry) => entry.name).join(", ")} (values hidden)`,
      );
  }
  const failure = status.failures.find(
    (item) => item.serverName === server.name,
  );
  lines.push(
    failure
      ? `status: failed - ${failure.message}`
      : status.connected.includes(server.name)
        ? "status: connected"
        : "status: configured; connection starts with the ACP session",
  );
  return lines.join("\n");
}

function mcpCounts(runner: SessionRunner): {
  configured: number;
  connected: number;
  failed: number;
  skills: number;
} {
  const status = runner.mcpSessionStatus();
  return {
    configured: status.configured.length,
    connected: status.connected.length,
    failed: status.failures.length,
    skills: runner.skillSessionStatus().length,
  };
}

function formatImageSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KiB`;
}

function formatContextUsage(usage: ContextUsage): string {
  const rows: Array<[string, number]> = [
    ["System", usage.categories.system],
    ["Conversation", usage.categories.conversation],
    ["Agents", usage.categories.agents],
    ["Thinking", usage.categories.thinking],
    ["Tools", usage.categories.tools],
    ["Skills", usage.categories.skills],
    ["Memory", usage.categories.memory],
  ];
  const lines = rows.map(([label, tokens]) => {
    const share = usage.totalTokens
      ? `${((tokens / usage.totalTokens) * 100).toFixed(1)}%`
      : "0.0%";
    return `${label.padEnd(14)} ${tokens.toLocaleString("en-US").padStart(10)}  ${share.padStart(6)}`;
  });
  const total = usage.contextWindow
    ? `${usage.totalTokens.toLocaleString("en-US")} / ${usage.contextWindow.toLocaleString("en-US")} (${usage.percentUsed?.toFixed(1) ?? "0.0"}%)`
    : usage.totalTokens.toLocaleString("en-US");
  const remaining =
    usage.remainingTokens === null
      ? null
      : `Remaining      ${usage.remainingTokens.toLocaleString("en-US").padStart(10)}`;

  return [
    "Estimated tokens in the next model request",
    "",
    ...lines,
    "",
    `Total          ${total}`,
    ...(remaining ? [remaining] : []),
    "",
    `Footer: ctx:${formatTokenCount(usage.totalTokens)}${usage.contextWindow ? `/${formatTokenCount(usage.contextWindow)}` : ""}`,
    "Counts are estimates because Nova models can use different tokenizers.",
  ].join("\n");
}
