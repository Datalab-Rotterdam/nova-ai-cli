import { Box, render, Static, Text, useBoxMetrics, useWindowSize } from "ink";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { StoredCredentials } from "@datalabrotterdam/nova-ai-agent/core/credentials.js";
import { savedPermissionMode } from "@datalabrotterdam/nova-ai-agent/core/policy/settings.js";
import { fromAgentPermissionMode, SessionRunner } from "../session/session-runner.js";
import { createStore, type Store } from "../state/store.js";
import type { UIState, UpdateAvailable } from "../state/types.js";
import { checkForUpdate } from "../../update-check.js";
import { detectKittyKeyboard, kittyKeyboardOverride } from "./terminal-keyboard.js";
import { PromptInput } from "./components/prompt-input.js";
import { StatusLine } from "./components/status-line.js";
import { TranscriptBlockView } from "./components/transcript.js";
import { TuiController, type ViewState } from "./controller.js";
import {
  PermissionDialog,
  QuestionDialog,
  ScrollPanel,
  SelectionDialog,
  ToolInspector,
} from "./dialogs/views.js";
import { formatElapsedTime } from "./format.js";
import { palette, WORKING_FRAMES } from "./theme.js";

export type InkTuiOptions = {
  /** Test seam for exercising the complete terminal application without HTTP. */
  createRunner?(store: Store<UIState>): SessionRunner;
  checkForUpdate?(): Promise<UpdateAvailable | null>;
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  /** Skips the terminal probe (tests). */
  kittyKeyboard?: boolean;
};

const FRAME_MS = 120;
const RESIZE_SETTLE_MS = 100;

export async function runInkTui(
  credentials: StoredCredentials,
  cwd: string,
  args: string[],
  options: InkTuiOptions = {},
): Promise<void> {
  const store = createStore<UIState>({
    messages: [],
    plan: [],
    pendingPermission: null,
    pendingQuestion: null,
    inputHistory: [],
    busy: false,
    mode: "chat",
    // Never from the repository's .nova-ai/settings.json: a cloned repo must
    // not be able to start Nova with approvals switched off.
    permissionMode: fromAgentPermissionMode(savedPermissionMode(cwd)),
    interactionMode: "agent",
    sessionId: "",
    cwd,
    statusLine: null,
    queuedCount: 0,
    contextUsage: null,
    updateAvailable: null,
  });
  const runner =
    options.createRunner?.(store) ?? new SessionRunner(store, credentials, cwd);
  const resumeIndex = args.indexOf("--resume");
  const resumeId = resumeIndex >= 0 ? args[resumeIndex + 1] : undefined;
  if (resumeId) runner.resumeFrom(resumeId);
  else store.setState({ sessionId: runner.sessionId });

  const stdout = options.stdout ?? process.stdout;
  const stdin = options.stdin ?? process.stdin;
  // Before Ink reads input: the kitty keyboard protocol is what lets the
  // terminal report Shift+Enter (new line) apart from Enter. Ink's own
  // "auto" probe delivers keys typed during the probe twice.
  const kittyKeyboard =
    options.kittyKeyboard ?? kittyKeyboardOverride() ?? (await detectKittyKeyboard(stdin, stdout));
  const controller = new TuiController(store, runner, {
    write: (data) => {
      stdout.write(data);
    },
  });
  const instance = render(<App controller={controller} />, {
    stdout,
    stdin,
    exitOnCtrlC: false,
    patchConsole: true,
    // Ink otherwise turns non-interactive whenever CI is set in the
    // environment; the TUI only runs on a terminal anyway.
    interactive: Boolean(stdout.isTTY),
    kittyKeyboard: { mode: kittyKeyboard ? "enabled" : "disabled" },
  });
  controller.start();

  const onSignal = () => controller.requestExit();
  process.once("SIGTERM", onSignal);

  // Once a width change settles (a drag sends many), print everything again.
  let printedColumns = stdout.columns;
  let resizeTimer: ReturnType<typeof setTimeout> | undefined;
  const onResize = () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (stdout.columns === printedColumns) return;
      printedColumns = stdout.columns;
      controller.redrawAll();
    }, RESIZE_SETTLE_MS);
  };
  stdout.on("resize", onResize);
  void (options.checkForUpdate ?? checkForUpdate)().then((updateAvailable) => {
    if (updateAvailable) store.setState({ updateAvailable });
  });

  try {
    await controller.exitRequested;
    // The exit frame drops the prompt and status so only the transcript stays.
    await instance.waitUntilRenderFlush();
    await controller.stop();
  } finally {
    process.off("SIGTERM", onSignal);
    stdout.off("resize", onResize);
    if (resizeTimer) clearTimeout(resizeTimer);
    instance.unmount();
    await instance.waitUntilExit().catch(() => {});
  }
  stdout.write(`Resume this session with: nova-ai --resume ${runner.sessionId}\n`);
}

export function App({ controller }: { controller: TuiController }) {
  const view = useSyncExternalStore(controller.subscribe, controller.getView);
  const { rows, columns } = useWindowSize();
  const bottomRef = useRef(null);
  const bottom = useBoxMetrics(bottomRef);
  const working = useWorking(view);

  const { transcript } = view;
  const scrollback = (
    // <Static> is laid out as an absolute box; without a width its text
    // wraps against its content and runs past the terminal edge.
    <Static key={transcript.epoch} items={[...transcript.committed]} style={{ width: columns }}>
      {(block) => (
        <Box key={block.key} marginTop={1}>
          <TranscriptBlockView block={block} />
        </Box>
      )}
    </Static>
  );
  if (view.exiting) return scrollback;

  // Ink redraws the whole screen (scrollback included) once a frame is as
  // tall as the terminal, so the live part keeps its newest rows only.
  const liveRows = Math.max(3, rows - (bottom.hasMeasured ? bottom.height : 6) - 2);
  const dialogRows = Math.max(6, rows - 4);
  return (
    <>
      {scrollback}
      <Box flexDirection="column" maxHeight={liveRows} overflowY="hidden" justifyContent="flex-end">
        <Box flexDirection="column" flexShrink={0}>
          {transcript.live.map((block) => (
            <Box key={block.key} marginTop={1}>
              <TranscriptBlockView block={block} frame={working.frame} />
            </Box>
          ))}
          {working.line ? (
            <Box marginTop={1} paddingLeft={1}>
              <Text>
                <Text color={palette.accent}>{WORKING_FRAMES[working.frame]}</Text>
                <Text color={palette.muted}>{` ${working.line}`}</Text>
              </Text>
            </Box>
          ) : null}
        </Box>
      </Box>
      <Box ref={bottomRef} flexDirection="column" marginTop={1}>
        <Surface controller={controller} view={view} rows={dialogRows} columns={columns} />
        <StatusLine ui={view.ui} model={view.model} mcp={view.mcp} />
      </Box>
    </>
  );
}

function Surface({
  controller,
  view,
  rows,
  columns,
}: {
  controller: TuiController;
  view: ViewState;
  rows: number;
  columns: number;
}) {
  if (view.question) return <QuestionDialog key={view.question.pending.id} state={view.question} />;
  const permission = view.ui.pendingPermission;
  if (permission)
    return <PermissionDialog key={permission.toolCallId} request={permission} onClose={() => {}} />;
  const overlay = view.overlay;
  if (overlay?.kind === "selection")
    return <SelectionDialog title={overlay.title} state={overlay.state} height={rows} />;
  if (overlay?.kind === "text")
    return (
      <ScrollPanel
        title={overlay.title}
        content={overlay.content}
        state={overlay.state}
        height={rows}
        width={columns}
      />
    );
  if (overlay?.kind === "tools") return <ToolInspector state={overlay.state} height={rows} width={columns} />;
  return (
    <PromptInput
      editor={controller.editor}
      busy={view.ui.busy}
      maxRows={Math.max(3, Math.floor(rows / 3))}
      onKey={(input, key) => controller.handlePromptKey(input, key)}
    />
  );
}

/** Spinner frame and "Working (12s • esc to interrupt)" while a turn runs. */
function useWorking(view: ViewState): { frame: number; line: string | null } {
  const busy = view.ui.busy;
  const pendingTool = view.ui.messages.some(
    (message) => message.role === "tool" && message.call.status === "pending",
  );
  const animating = busy || pendingTool;
  const [frame, setFrame] = useState(0);
  const startedAt = useRef<number | null>(null);
  if (busy && startedAt.current === null) startedAt.current = Date.now();
  if (!busy) startedAt.current = null;

  useEffect(() => {
    if (!animating) {
      setFrame(0);
      return;
    }
    const timer = setInterval(() => setFrame((value) => (value + 1) % WORKING_FRAMES.length), FRAME_MS);
    return () => clearInterval(timer);
  }, [animating]);

  if (!busy || pendingTool || view.ui.pendingPermission || view.question) return { frame, line: null };
  const elapsed = formatElapsedTime(Date.now() - (startedAt.current ?? Date.now()));
  return { frame, line: `Working (${elapsed} • esc to interrupt)` };
}
