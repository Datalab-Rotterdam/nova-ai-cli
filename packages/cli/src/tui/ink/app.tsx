import { Box, render, Text, useBoxMetrics, useInput, useWindowSize } from "ink";
import { memo, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { StoredCredentials } from "@datalabrotterdam/nova-ai-agent/core/credentials.js";
import { savedPermissionMode } from "@datalabrotterdam/nova-ai-agent/core/policy/settings.js";
import { fromAgentPermissionMode, SessionRunner } from "../session/session-runner.js";
import { createStore, type Store } from "../state/store.js";
import type { UIState, UpdateAvailable } from "../state/types.js";
import { checkForUpdate } from "../../update-check.js";
import {
  detectKittyKeyboard,
  kittyKeyboardOverride,
  MOUSE_REPORTING_OFF,
  MOUSE_REPORTING_ON,
} from "./terminal-keyboard.js";
import { ScreenSelection } from "./screen-selection.js";
import { PromptInput, Suggestions } from "./components/prompt-input.js";
import { StatusLine, StatusNotices, statusActions } from "./components/status-line.js";
import stringWidth from "string-width";
import { TranscriptBlockView } from "./components/transcript.js";
import { WelcomeLogo } from "./components/welcome-logo.js";
import { TuiController, type ViewState } from "./controller.js";
import type { TranscriptBlock } from "./transcript/committer.js";
import {
  PermissionDialog,
  QuestionDialog,
  ScrollPanel,
  SelectionDialog,
  SliderDialog,
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

export type InkTuiResult = {
  sessionId: string;
  /** /update: install the newer version and restart once the TUI is gone. */
  updateRequested: boolean;
};

export async function runInkTui(
  credentials: StoredCredentials,
  cwd: string,
  args: string[],
  options: InkTuiOptions = {},
): Promise<InkTuiResult> {
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
  const selection = new ScreenSelection(stdout);
  const controller = new TuiController(store, runner, {
    write: (data) => {
      stdout.write(data);
    },
    selection,
  });
  const instance = render(<App controller={controller} />, {
    stdout: selection.wrap(stdout),
    stdin,
    exitOnCtrlC: false,
    patchConsole: true,
    // Ink otherwise turns non-interactive whenever CI is set in the
    // environment; the TUI only runs on a terminal anyway.
    interactive: Boolean(stdout.isTTY),
    // Full screen: the transcript scrolls inside the app (PgUp/PgDn) and the
    // terminal gets its own screen back on exit.
    alternateScreen: Boolean(stdout.isTTY),
    kittyKeyboard: { mode: kittyKeyboard ? "enabled" : "disabled" },
  });
  controller.start();
  // The wheel scrolls the transcript and a drag selects text (see
  // ScreenSelection); Shift (Option in some macOS terminals) + drag still
  // selects natively.
  if (stdout.isTTY) stdout.write(MOUSE_REPORTING_ON);

  const onSignal = () => controller.requestExit();
  process.once("SIGTERM", onSignal);

  void (options.checkForUpdate ?? checkForUpdate)().then((updateAvailable) => {
    if (updateAvailable) store.setState({ updateAvailable });
  });

  try {
    await controller.exitRequested;
    await instance.waitUntilRenderFlush();
    await controller.stop();
  } finally {
    process.off("SIGTERM", onSignal);
    if (stdout.isTTY) stdout.write(MOUSE_REPORTING_OFF);
    instance.unmount();
    await instance.waitUntilExit().catch(() => {});
  }
  stdout.write(`Resume this session with: nova-ai --resume ${runner.sessionId}\n`);
  return { sessionId: runner.sessionId, updateRequested: controller.updateRequested };
}

export function App({ controller }: { controller: TuiController }) {
  const view = useSyncExternalStore(controller.subscribe, controller.getView);
  useSyncExternalStore(controller.editor.subscribe, controller.editor.getVersion);
  const { rows, columns } = useWindowSize();
  const viewportRef = useRef(null);
  const viewport = useBoxMetrics(viewportRef);
  const contentRef = useRef(null);
  const content = useBoxMetrics(contentRef);
  const working = useWorking(view);
  const [userTops, setUserTops] = useState<ReadonlyMap<string, number>>(new Map());
  useInput((input) => controller.handleMouse(input, (row, col) => {
    if (row === height - 1 && view.ui.contextUsage && col >= 2) {
      void controller.openUsageInspector();
      return true;
    }
    if (row !== height - 2) return false;
    let start = 2 + (view.scroll ? stringWidth(`↑${view.scroll} lines · PgDn/Esc`) + 3 : 0);
    for (const action of statusActions(view.model, view.ui, view.mcp)) {
      const end = start + stringWidth(action.label);
      if (col >= start && col < Math.min(end, columns - 1)) {
        if (action.id === "model") void controller.openModels();
        else if (action.id === "mode") controller.openInteractionModes();
        else if (action.id === "permissions") controller.openPermissionModes();
        else if (action.id === "skills") void controller.openSkillInspector();
        return true;
      }
      start = end + 3;
    }
    return false;
  }));

  // One row short of the terminal: Ink clears the whole screen for every
  // frame that is exactly as tall (always on Windows), which flickers.
  const height = Math.max(4, rows - 1);
  // Notices have a permanent, bounded area so their arrival never changes the viewport or prompt.
  const noticeRows = 2;
  const viewportRows = viewport.hasMeasured ? viewport.height : Math.max(1, height - noticeRows - 5);
  useEffect(() => {
    if (content.hasMeasured) controller.setViewport(viewportRows, content.height);
  }, [controller, viewportRows, content.hasMeasured, content.height]);

  if (view.exiting) return null;

  const { transcript } = view;
  const blocks = [...transcript.committed, ...transcript.live];
  const activeDialog = !!(view.question || view.ui.pendingPermission || view.overlay);
  const autocomplete = !activeDialog ? controller.editor.autocomplete : null;
  const liveKeys = new Set(transcript.live.map((block) => block.key));
  const onUserTop = (key: string, top: number) =>
    setUserTops((tops) => (tops.get(key) === top ? tops : new Map(tops).set(key, top)));

  // The prompt behind the rows on screen, once it has scrolled off the top.
  const firstVisibleRow = Math.max(0, content.height - viewportRows - view.scroll);
  let sticky: string | null = null;
  for (const block of blocks) {
    if (block.kind !== "user") continue;
    const top = userTops.get(block.key);
    if (top !== undefined && top < firstVisibleRow) sticky = block.text;
  }

  // ponytail: renders the whole transcript every frame (memoized blocks keep
  // that cheap); window to the blocks near the viewport if long sessions lag.
  return (
    <Box flexDirection="column" height={height}>
      <Box
        ref={viewportRef}
        flexDirection="column"
        flexGrow={1}
        flexShrink={1}
        minHeight={0}
        overflowY="hidden"
        justifyContent={content.hasMeasured && content.height > viewportRows ? "flex-end" : "flex-start"}
      >
        <Box ref={contentRef} flexDirection="column" flexShrink={0} marginBottom={-view.scroll}>
          {blocks.map((block) =>
            liveKeys.has(block.key) ? (
              <Box key={block.key} marginTop={1}>
                <TranscriptBlockView block={block} frame={working.frame} />
              </Box>
            ) : (
              <CommittedBlock key={block.key} block={block} onUserTop={onUserTop} />
            ),
          )}
          {working.line ? (
            <Box marginTop={1} paddingLeft={1}>
              <Text>
                <Text color={palette.accent}>{WORKING_FRAMES[working.frame]}</Text>
                <Text color={palette.muted}>{` ${working.line}`}</Text>
              </Text>
            </Box>
          ) : null}
        </Box>
        {blocks.every((block) => block.kind === "header") && !view.ui.busy ? (
          <WelcomeLogo columns={columns} rows={viewportRows} />
        ) : null}
        {sticky !== null ? <StickyPrompt text={sticky} columns={columns} /> : null}
        {activeDialog || autocomplete ? (
          <Box position="absolute" bottom={0} left={1} width={Math.max(1, columns - 2)} flexDirection="column" backgroundColor="#151b24" overflowY="hidden" maxHeight={viewportRows}>
            {activeDialog ? <DialogSurface view={view} rows={Math.max(3, viewportRows)} columns={columns - 2} /> : autocomplete ? <Suggestions view={autocomplete} limit={Math.max(1, viewportRows - 1)} /> : null}
          </Box>
        ) : null}
      </Box>
      <Box height={noticeRows} flexShrink={0} paddingX={1} overflowY="hidden">
        <StatusNotices ui={view.ui} />
      </Box>
      <Box flexDirection="column" flexShrink={0} paddingX={1}>
        <PromptInput editor={controller.editor} busy={view.ui.busy} isActive={!activeDialog}
          maxRows={Math.max(1, Math.floor((rows - 4) / 3))}
          onKey={(input, key) => controller.handlePromptKey(input, key)} />
        <StatusLine ui={view.ui} model={view.model} effort={view.effort} mcp={view.mcp} scroll={view.scroll} />
      </Box>
    </Box>
  );
}

/** A final block: rendered once per epoch; user prompts report their row for the sticky prompt. */
const CommittedBlock = memo(function CommittedBlock({
  block,
  onUserTop,
}: {
  block: TranscriptBlock;
  onUserTop(key: string, top: number): void;
}) {
  if (block.kind !== "user") {
    return (
      <Box marginTop={1}>
        <TranscriptBlockView block={block} />
      </Box>
    );
  }
  return (
    <UserAnchor block={block} onUserTop={onUserTop}>
      <TranscriptBlockView block={block} />
    </UserAnchor>
  );
}, (before, after) => before.block === after.block);

function UserAnchor({
  block,
  onUserTop,
  children,
}: {
  block: TranscriptBlock;
  onUserTop(key: string, top: number): void;
  children: ReactNode;
}) {
  const ref = useRef(null);
  const { top, hasMeasured } = useBoxMetrics(ref);
  useEffect(() => {
    if (hasMeasured) onUserTop(block.key, top);
  }, [block.key, top, hasMeasured]);
  return (
    <Box ref={ref} marginTop={1}>
      {children}
    </Box>
  );
}

/** Drawn over the viewport's first row; padded so the row under it doesn't show through. */
function StickyPrompt({ text, columns }: { text: string; columns: number }) {
  const line = `> ${text.replace(/\s+/g, " ").trim()}`;
  return (
    <Box position="absolute" top={0} left={0} width={columns}>
      <Text color={palette.primary} backgroundColor={palette.stickyBackground} wrap="truncate-end">
        {line.padEnd(columns)}
      </Text>
    </Box>
  );
}

function DialogSurface({
  view,
  rows,
  columns,
}: {
  view: ViewState;
  rows: number;
  columns: number;
}) {
  const permission = view.ui.pendingPermission;
  const overlay = view.overlay;
  const dialogRows = rows;
  let dialog: ReactNode = null;
  if (view.question) dialog = <QuestionDialog key={view.question.pending.id} state={view.question} />;
  else if (permission)
    dialog = (
      <PermissionDialog
        key={permission.toolCallId}
        request={permission}
        onClose={() => {}}
        cwd={view.ui.cwd}
        height={dialogRows}
        width={columns}
      />
    );
  else if (overlay?.kind === "selection")
    dialog = <SelectionDialog title={overlay.title} state={overlay.state} height={dialogRows} />;
  else if (overlay?.kind === "slider") dialog = <SliderDialog title={overlay.title} state={overlay.state} />;
  else if (overlay?.kind === "text")
    dialog = (
      <ScrollPanel
        title={overlay.title}
        content={overlay.content}
        state={overlay.state}
        height={dialogRows}
        width={columns}
      />
    );
  else if (overlay?.kind === "tools") dialog = <ToolInspector state={overlay.state} height={dialogRows} width={columns} />;
  return dialog;
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
