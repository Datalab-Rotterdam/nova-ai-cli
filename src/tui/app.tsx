import type { StoredCredentials } from "../acp/credentials.js";
import { Text, useApp, useInput } from "ink";
import React, { useMemo, useRef, useState } from "react";
import { Banner } from "./components/Banner.js";
import { InputBar } from "./components/InputBar.js";
import { Layout } from "./components/Layout.js";
import { MessageList } from "./components/MessageList.js";
import { ThinkingIndicator } from "./components/ThinkingIndicator.js";
import { ModelPicker, type ModelOption } from "./components/ModelPicker.js";
import { PermissionModePicker } from "./components/PermissionModePicker.js";
import { PermissionPrompt } from "./components/PermissionPrompt.js";
import { SessionSwitcher } from "./components/SessionSwitcher.js";
import { findCommand } from "./commands/index.js";
import { listWorkspaceFiles } from "./files/list-workspace-files.js";
import { useStore } from "./hooks/useStore.js";
import { listSessionsForCwd } from "./session/session-picker.js";
import { SessionRunner } from "./session/session-runner.js";
import { readWorkspaceSettings, setPermissionMode as persistPermissionMode } from "./settings/workspace-settings.js";
import { createStore } from "./state/store.js";
import type { InteractionMode, PermissionMode, UIState } from "./state/types.js";
import { ThemeContext, resolveTheme } from "./theme/index.js";
import { useTerminalRows } from "./hooks/useTerminalRows.js";

const PERMISSION_PROMPT_HEIGHT = 9;
const PERMISSION_MODE_LINE_HEIGHT = 1;
const PICKER_LIST_CAP = 10;
const BANNER_HEIGHT = 4;

const INTERACTION_MODES: InteractionMode[] = ["plan", "ask", "agent"];

export function App({
  credentials,
  cwd,
  resumeSessionId,
}: {
  credentials: StoredCredentials;
  cwd: string;
  resumeSessionId?: string;
}): React.ReactElement {
  const { exit } = useApp();
  const theme = resolveTheme(process.env.NOVA_THEME);
  const workspaceSettings = useMemo(() => readWorkspaceSettings(cwd), [cwd]);

  const store = useMemo(
    () => createStore<UIState>({
      messages: [],
      pendingPermission: null,
      inputHistory: [],
      busy: false,
      mode: "chat",
      permissionMode: workspaceSettings.permissionMode ?? "ask",
      interactionMode: "agent",
      sessionId: "",
      cwd,
      statusLine: null,
      queuedCount: 0,
    }),
    [workspaceSettings.permissionMode],
  );

  const files = useMemo(() => listWorkspaceFiles(cwd), []);

  const runner = useMemo(() => {
    const r = new SessionRunner(store, credentials, cwd, files);
    if (resumeSessionId) r.resumeFrom(resumeSessionId);
    else store.setState({ sessionId: r.sessionId });
    return r;
  }, []);

  const [sessions, setSessions] = useState<ReturnType<typeof listSessionsForCwd>>([]);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [inputBarHeight, setInputBarHeight] = useState(3);
  const pendingExit = useRef(false);
  const printedResumeCommand = useRef(false);

  const resumeCommand = () => `nova-ai --resume ${runner.sessionId}`;
  const printResumeCommand = () => {
    if (printedResumeCommand.current) return;
    printedResumeCommand.current = true;
    console.log(`Resume this session with: ${resumeCommand()}`);
  };
  const exitWithResumeCommand = () => {
    printResumeCommand();
    exit();
  };
  const confirmExitOnNextCtrlC = (prefix = "Press Ctrl+C again to exit.") => {
    pendingExit.current = true;
    store.setState({ statusLine: `${prefix} Resume with: ${resumeCommand()}` });
  };
  const setInteractionMode = (mode: InteractionMode) => {
    runner.interactionMode = mode;
    store.setState({ interactionMode: mode, statusLine: `Mode: ${mode}` });
  };
  const cycleInteractionMode = () => {
    const current = INTERACTION_MODES.indexOf(runner.interactionMode);
    setInteractionMode(INTERACTION_MODES[(current + 1) % INTERACTION_MODES.length]);
  };
  const setPermissionMode = (mode: PermissionMode) => {
    store.setState({ permissionMode: mode, statusLine: `Permission mode: ${mode}` });
    persistPermissionMode(cwd, mode);
  };
  const openPermissionPicker = () => store.setState({ mode: "permission-picker" });

  const openModelPicker = () => {
    store.setState({ mode: "model-picker" });
    setModelsLoading(true);
    runner
      .listModels()
      .then((list) => setModels(list))
      .catch((err) => {
        store.setState((s) => ({
          mode: "chat",
          messages: [
            ...s.messages,
            { id: `cmd-${Date.now()}`, role: "error", text: `Failed to list models: ${err instanceof Error ? err.message : "unknown error"}` },
          ],
        }));
      })
      .finally(() => setModelsLoading(false));
  };

  const state = useStore(store, (s) => s);
  const rows = useTerminalRows();

  const pickerHeight =
    state.mode === "session-switcher"
      ? 5 + Math.max(1, Math.min(sessions.length, PICKER_LIST_CAP))
      : state.mode === "model-picker"
        ? 5 + Math.max(1, Math.min(models.length, PICKER_LIST_CAP))
        : state.mode === "permission-picker"
          ? 8
          : 0;
  const reserved =
    BANNER_HEIGHT +
    (state.busy ? 1 : 0) +
    pickerHeight +
    (state.pendingPermission ? PERMISSION_PROMPT_HEIGHT : 0) +
    inputBarHeight +
    (state.queuedCount > 0 ? 1 : 0) +
    (state.statusLine ? 1 : 0) +
    PERMISSION_MODE_LINE_HEIGHT;
  const liveMaxHeight = Math.max(3, rows - reserved);

  useInput((_input, key) => {
    if (key.ctrl && _input === "c") {
      if (pendingExit.current) {
        exitWithResumeCommand();
        return;
      }
      if (state.busy) {
        runner.cancel();
        confirmExitOnNextCtrlC("Request canceled. Press Ctrl+C again to exit.");
        return;
      }
      confirmExitOnNextCtrlC();
      return;
    }
    if (key.shift && key.tab && state.mode === "chat" && !state.pendingPermission) {
      cycleInteractionMode();
      return;
    }
    if (key.ctrl && _input === "r") {
      setSessions(listSessionsForCwd(runner.cwd));
      store.setState({ mode: "session-switcher" });
    }
    if (key.ctrl && _input === "p") {
      openModelPicker();
    }
    if (key.ctrl && _input === "k") {
      openPermissionPicker();
    }
  });

  const handleSubmit = (text: string) => {
    pendingExit.current = false;
    store.setState((s) => ({ inputHistory: [...s.inputHistory, text], statusLine: null }));

    if (text.startsWith("/")) {
      const [name, ...rest] = text.slice(1).split(" ");
      const command = findCommand(name);
      if (!command) {
        store.setState((s) => ({
          messages: [...s.messages, { id: `cmd-${Date.now()}`, role: "error", text: `Unknown command: /${name}` }],
        }));
        return;
      }
      command.run(
        {
          print: (t) =>
            store.setState((s) => ({ messages: [...s.messages, { id: `cmd-${Date.now()}`, role: "assistant", text: t, streaming: false }] })),
          clear: () => store.setState({ messages: [] }),
          newSession: () => runner.startNewSession(),
          exit: exitWithResumeCommand,
          resumeSession: (sessionId) => {
            const id = sessionId ?? listSessionsForCwd(runner.cwd)[0]?.sessionId;
            if (!id) return false;
            return runner.resumeFrom(id);
          },
          openSessionSwitcher: () => {
            setSessions(listSessionsForCwd(runner.cwd));
            store.setState({ mode: "session-switcher" });
          },
          openModelPicker,
          getModel: () => runner.model,
          setModel: (model) => {
            runner.setModel(model);
            store.setState({ statusLine: null });
          },
          getInteractionMode: () => runner.interactionMode,
          setInteractionMode,
          getPermissionMode: () => state.permissionMode,
          setPermissionMode,
          openPermissionPicker,
          listModels: () => runner.listModels(),
          startBackgroundShell: (command) => runner.startBackgroundShell(command),
          startBackgroundAgent: (prompt) => runner.startBackgroundAgent(prompt),
          listBackgroundJobs: (kind) => runner.listBackgroundJobs(kind),
          backgroundOutput: (jobId) => runner.backgroundOutput(jobId),
          killBackgroundJob: (jobId) => runner.killBackgroundJob(jobId),
          releaseBackgroundJob: (jobId) => runner.releaseBackgroundJob(jobId),
        },
        rest.join(" "),
      );
      return;
    }

    void runner.submit(text);
  };

  return (
    <ThemeContext.Provider value={theme}>
      <Layout>
        <Banner cwd={state.cwd} />
        <MessageList messages={state.messages} maxLiveHeight={liveMaxHeight} />
        <ThinkingIndicator busy={state.busy} />
        {state.mode === "session-switcher" ? (
          <SessionSwitcher
            sessions={sessions}
            onSelect={(id) => {
              runner.resumeFrom(id);
              store.setState({ mode: "chat" });
            }}
            onCancel={() => store.setState({ mode: "chat" })}
          />
        ) : null}
        {state.mode === "model-picker" ? (
          <ModelPicker
            models={models}
            currentModel={runner.model}
            loading={modelsLoading}
            onSelect={(id) => {
              runner.setModel(id);
              store.setState({ mode: "chat" });
            }}
            onCancel={() => store.setState({ mode: "chat" })}
          />
        ) : null}
        {state.mode === "permission-picker" ? (
          <PermissionModePicker
            currentMode={state.permissionMode}
            onSelect={(mode) => {
              setPermissionMode(mode);
              store.setState({ mode: "chat" });
            }}
            onCancel={() => store.setState({ mode: "chat" })}
          />
        ) : null}
        {state.pendingPermission ? <PermissionPrompt request={state.pendingPermission} /> : null}
        <InputBar
          history={state.inputHistory}
          disabled={state.mode !== "chat" || !!state.pendingPermission}
          files={files}
          onSubmit={handleSubmit}
          onHeightChange={setInputBarHeight}
        />
        {state.queuedCount > 0 ? (
          <Text color={theme.muted}>{state.queuedCount} message{state.queuedCount > 1 ? "s" : ""} queued…</Text>
        ) : null}
        {state.statusLine ? <Text color={theme.muted}>{state.statusLine}</Text> : null}
        <Text>
          <Text color={theme.muted}>{runner.model ?? "no model"} - {state.interactionMode} - </Text>
          <Text color={state.permissionMode === "ask" ? theme.warning : state.permissionMode === "acceptEdits" ? theme.success : theme.error}>
            {state.permissionMode === "ask" ? "⚠ permissions: ask" : state.permissionMode === "acceptEdits" ? "✓ permissions: accept edits" : "✗ permissions: bypass all"}
          </Text>
        </Text>
      </Layout>
    </ThemeContext.Provider>
  );
}
