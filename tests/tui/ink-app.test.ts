import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import test from "node:test";
import type * as acp from "@agentclientprotocol/sdk";
import type { Terminal as HeadlessTerminal } from "@xterm/headless";
import { kittyKeyboardSupported, runInkTui } from "../../src/tui/ink/app.js";
import { SessionRunner } from "../../src/tui/session/session-runner.js";
import type { Store } from "../../src/tui/state/store.js";
import type { PermissionScope, UIState } from "../../src/tui/state/types.js";
import { installFakeAgentQueue } from "./fake-agent-queue.js";

const { Terminal } = createRequire(import.meta.url)("@xterm/headless") as typeof import("@xterm/headless");

/** A terminal for Ink: output goes into a headless xterm we can read back. */
class FakeTerminalOutput extends EventEmitter {
  readonly isTTY = true;
  columns = 80;
  rows = 24;
  raw = "";
  constructor(private readonly terminal: HeadlessTerminal) {
    super();
  }
  write(data: string): boolean {
    this.raw += data;
    this.terminal.write(data);
    return true;
  }
  /** Like a real window resize: the terminal re-wraps, then the app is told. */
  resize(columns: number, rows: number): void {
    this.columns = columns;
    this.rows = rows;
    this.terminal.resize(columns, rows);
    this.emit("resize");
  }
}

class FakeTerminalInput extends EventEmitter {
  readonly isTTY = true;
  private readonly pending: string[] = [];
  setRawMode(): this {
    return this;
  }
  setEncoding(): this {
    return this;
  }
  ref(): this {
    return this;
  }
  unref(): this {
    return this;
  }
  resume(): this {
    return this;
  }
  pause(): this {
    return this;
  }
  read(): string | null {
    return this.pending.shift() ?? null;
  }
  send(data: string): void {
    this.pending.push(data);
    this.emit("readable");
  }
}

function text(terminal: HeadlessTerminal, from = 0): string {
  const buffer = terminal.buffer.active;
  const lines: string[] = [];
  for (let index = from; index < buffer.length; index++) {
    lines.push(buffer.getLine(index)?.translateToString(true) ?? "");
  }
  return lines.join("\n");
}

const screen = (terminal: HeadlessTerminal) => text(terminal, terminal.buffer.active.baseY);

async function waitFor(check: () => boolean, describe: () => string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    if (check()) return;
  }
  throw new Error(`Timed out. Screen:\n${describe()}`);
}

test("the Ink TUI runs a prompt, answers a permission, redraws on Ctrl+O and exits on Ctrl+C twice", async () => {
  const terminal = new Terminal({ cols: 80, rows: 24, allowProposedApi: true, scrollback: 1_000, convertEol: true });
  const stdout = new FakeTerminalOutput(terminal);
  const stdin = new FakeTerminalInput();
  let store!: Store<UIState>;
  const prompts: string[] = [];

  const run = runInkTui({ apiKey: "test", defaultModel: "test-model" }, process.cwd(), [], {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    checkForUpdate: async () => null,
    createRunner(created) {
      store = created;
      const runner = new SessionRunner(created, { apiKey: "test", defaultModel: "test-model" }, process.cwd());
      installFakeAgentQueue(runner);
      const internals = runner as unknown as {
        agent: { prompt(params: acp.PromptRequest): Promise<{ stopReason: "end_turn" }> };
      };
      internals.agent.prompt = async (params) => {
        const prompt = params.prompt.map((block) => (block.type === "text" ? block.text : "")).join("");
        prompts.push(prompt);
        created.setState((state) => ({
          messages: [
            ...state.messages,
            { id: `reply-${prompts.length}`, role: "assistant", text: `**echo**: ${prompt}`, streaming: false },
          ],
        }));
        return { stopReason: "end_turn" };
      };
      return runner;
    },
  });

  const show = () => screen(terminal);
  await waitFor(() => /Nova AI/.test(show()) && /test-model \| agent/.test(show()), show);
  assert.match(stdout.raw, /\u001b\]0;✦ Nova AI\u0007/, "window title");

  stdin.send("hello there\r");
  await waitFor(() => /echo: hello there/.test(show()), show);
  assert.deepEqual(prompts, ["hello there"]);

  stdin.send("\u001b[Z"); // Shift+Tab
  await waitFor(() => /test-model \| ask \|/.test(show()), show);

  const answers: Array<[boolean, PermissionScope]> = [];
  store.setState({
    pendingPermission: {
      toolCallId: "tool-1",
      toolName: "run_command",
      title: "Run `npm test`",
      kind: "execute",
      args: { command: "npm test" },
      resolve(allow, scope) {
        answers.push([allow, scope]);
        store.setState({ pendingPermission: null });
      },
    },
  });
  await waitFor(() => /\[a\] once/.test(show()), show);
  assert.doesNotMatch(show(), /╭─+╮\n│>/, "the prompt is replaced by the dialog");
  stdin.send("s");
  await waitFor(() => answers.length === 1 && /│>/.test(show()), show);
  assert.deepEqual(answers, [[true, "session"]]);

  stdin.send("\u000f"); // Ctrl+O redraws the transcript with verbose tools
  await waitFor(() => /Verbose tool details expanded/.test(show()), show);
  assert.match(stdout.raw, /\u001b\[2J\u001b\[3J\u001b\[H/);
  await waitFor(() => /echo: hello there/.test(text(terminal)), () => text(terminal));
  assert.equal(text(terminal).match(/echo: hello there/g)?.length, 1, "printed once after the redraw");

  stdin.send("\u0003");
  await waitFor(() => /Press Ctrl\+C again within 2s to exit\./.test(show()), show);
  stdin.send("\u0003");
  await run;
  assert.match(stdout.raw, /Resume this session with: nova-ai --resume /);
  assert.match(text(terminal), /echo: hello there/, "the transcript stays after exit");
  assert.doesNotMatch(screen(terminal), /test-model \| ask/, "the prompt and status are removed on exit");
  terminal.dispose();
});

test("a long streaming answer stays below the terminal height instead of repainting the screen", async () => {
  const terminal = new Terminal({ cols: 60, rows: 16, allowProposedApi: true, scrollback: 1_000, convertEol: true });
  const stdout = new FakeTerminalOutput(terminal);
  Object.defineProperty(stdout, "columns", { value: 60 });
  Object.defineProperty(stdout, "rows", { value: 16 });
  const stdin = new FakeTerminalInput();
  let store!: Store<UIState>;
  const run = runInkTui({ apiKey: "test", defaultModel: "test-model" }, process.cwd(), [], {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    checkForUpdate: async () => null,
    createRunner(created) {
      store = created;
      const runner = new SessionRunner(created, { apiKey: "test", defaultModel: "test-model" }, process.cwd());
      installFakeAgentQueue(runner);
      return runner;
    },
  });
  const show = () => screen(terminal);
  await waitFor(() => /test-model \| agent/.test(show()), show);
  const startOutput = stdout.raw.length;

  const code = Array.from({ length: 60 }, (_, index) => `const line${index} = ${index};`).join("\n");
  store.setState({
    busy: true,
    messages: [{ id: "a1", role: "assistant", text: `\`\`\`ts\n${code}`, streaming: true }],
  });
  await waitFor(() => /line59 = 59/.test(show()), show);
  const streamed = stdout.raw.slice(startOutput);
  assert.doesNotMatch(streamed, /\u001b\[2J/, "no full-screen repaint");
  assert.match(show(), /test-model \| agent \| ask \| working/, "the prompt and status stay visible");
  assert.doesNotMatch(show(), /line0 = 0;/, "older streaming rows are clipped from the live area");

  store.setState({
    busy: false,
    messages: [{ id: "a1", role: "assistant", text: `\`\`\`ts\n${code}\n\`\`\``, streaming: false }],
  });
  await waitFor(() => /line0 = 0;/.test(text(terminal)), () => text(terminal));
  assert.equal(text(terminal).match(/line0 = 0;/g)?.length, 1, "the finished answer is printed to the scrollback once");

  stdin.send("\u0003");
  stdin.send("\u0003");
  await run;
  terminal.dispose();
});

test("resizing redraws cleanly without leftover prompt borders", async () => {
  const terminal = new Terminal({ cols: 100, rows: 30, allowProposedApi: true, scrollback: 1_000, convertEol: true });
  const stdout = new FakeTerminalOutput(terminal);
  stdout.columns = 100;
  stdout.rows = 30;
  const stdin = new FakeTerminalInput();
  let store!: Store<UIState>;
  const run = runInkTui({ apiKey: "test", defaultModel: "test-model" }, process.cwd(), [], {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    checkForUpdate: async () => null,
    createRunner(created) {
      store = created;
      const runner = new SessionRunner(created, { apiKey: "test", defaultModel: "test-model" }, process.cwd());
      installFakeAgentQueue(runner);
      return runner;
    },
  });
  const show = () => screen(terminal);
  await waitFor(() => /test-model \| agent/.test(show()), show);
  store.setState({
    messages: [{ id: "a1", role: "assistant", text: `Once upon a time. ${"A story about a lantern. ".repeat(12)}`, streaming: false }],
  });
  await waitFor(() => /lantern/.test(show()), show);

  // Shrink step by step, the way dragging a window edge does.
  for (const columns of [96, 90, 84, 77, 70, 64]) {
    stdout.resize(columns, 30);
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  await waitFor(
    () => (text(terminal).match(/╭/g)?.length ?? 0) === 1 && /test-model \| agent/.test(show()),
    () => text(terminal),
  );
  assert.equal(text(terminal).match(/Once upon a time/g)?.length, 1, "the answer is printed once");
  assert.equal(text(terminal).match(/Nova AI/g)?.length, 1, "the header is printed once");

  stdin.send("\u0003");
  stdin.send("\u0003");
  await run;
  terminal.dispose();
});

test("the kitty keyboard protocol is only switched on for terminals known to support it", () => {
  assert.equal(kittyKeyboardSupported({ TERM: "xterm-kitty" }), true);
  assert.equal(kittyKeyboardSupported({ TERM_PROGRAM: "WezTerm" }), true);
  assert.equal(kittyKeyboardSupported({ TERM: "xterm-256color", TERM_PROGRAM: "Apple_Terminal" }), false);
  assert.equal(kittyKeyboardSupported({ TERM: "xterm-256color", NOVA_KITTY_KEYBOARD: "1" }), true);
  assert.equal(kittyKeyboardSupported({ TERM: "xterm-kitty", NOVA_KITTY_KEYBOARD: "0" }), false);
});
