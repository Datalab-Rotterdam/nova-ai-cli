import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { Terminal as HeadlessTerminal } from "@xterm/headless";
import * as pty from "node-pty";

const ESCAPE = "\u001b";
let scenarioTempDir: string | null = null;
const { Terminal } = createRequire(import.meta.url)(
  "@xterm/headless",
) as typeof import("@xterm/headless");

async function runPtyScenario(): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), "nova-pty-e2e-"));
  scenarioTempDir = cwd;
  const harness = spawnFixture(cwd, 72, 22);
  try {
    await harness.waitFor(/Nova AI/);
    await harness.waitForOutput(/\u001b\]0;✦ Nova AI\u0007/);

    harness.write("hold initial request\r");
    await harness.waitFor(/Working \(/);
    await harness.waitForOutput(/\u001b\]0;✦ Nova-AI\u0007/);
    await harness.waitForOutput(/\u001b\]0;✧ Nova-AI\u0007/);
    await harness.waitForOutput(/\u001b\]0;· Nova-AI\u0007/);

    harness.write("queued follow-up\r");
    await harness.waitFor(/queued>.*queued follow-up/);

    harness.write(`${ESCAPE}[A`);
    await harness.waitFor(/> queued follow-up/);
    harness.write("!");
    await harness.waitFor(/queued>.*queued follow-up!/);
    harness.write("\r");

    harness.write("fixture-release\r");
    await harness.waitFor(/fixture completed: queued follow-up!/);
    assert.doesNotMatch(harness.screen(), /queued>/);

    harness.write("hold cancel-me\r");
    await harness.waitFor(/Working \(/);
    harness.write(ESCAPE);
    await harness.waitFor(/Request cancel/);

    harness.write("fixture-fill\r");
    await harness.waitFor(/fixture scroll line 48/);
    harness.write(`${ESCAPE}[<64;10;10M`.repeat(5));
    await harness.waitFor(/fixture scroll line 2\d/);
    assert.doesNotMatch(harness.screen(), /fixture scroll line 48/);

    harness.resize(96, 30);
    await harness.waitFor(/fixture scroll line 2\d/);
    assert.equal(harness.columns, 96);
    assert.equal(harness.rows, 30);

    harness.write("\u0003");
    await harness.waitFor(/Press Ctrl\+C again within 2s to exit\./);
    harness.write("\u0003");
    await harness.waitForOutput(/NOVA_PTY_FIXTURE_DONE/);
    const exit = await harness.waitForExit();
    assert.equal(exit.exitCode, 0, harness.output());
    assert.match(
      harness.output(),
      /Resume this session with: nova-ai --resume /,
    );
    assert.match(harness.output(), /\u001b\[\?1049l/);
  } finally {
    harness.dispose();
  }
}

type ExitEvent = { exitCode: number; signal?: number };

class PtyHarness {
  readonly exited: Promise<ExitEvent>;
  private readonly terminal: HeadlessTerminal;
  private readonly process: pty.IPty;
  private rawOutput = "";
  private disposed = false;
  private exitEvent: ExitEvent | null = null;

  constructor(
    file: string,
    args: string[],
    cwd: string,
    public columns: number,
    public rows: number,
  ) {
    this.terminal = new Terminal({
      cols: columns,
      rows,
      allowProposedApi: true,
      scrollback: 2_000,
    });
    this.process = pty.spawn(file, args, {
      name: "xterm-256color",
      cols: columns,
      rows,
      cwd,
      env: {
        ...process.env,
        TERM: "xterm-256color",
        NO_COLOR: "1",
      },
      // The packaged ConPTY DLL has deterministic process-tree teardown. The
      // native Windows fallback spawns a console-list helper after exit, which
      // can lose an AttachConsole race on current Windows/Node combinations.
      useConptyDll: process.platform === "win32",
    });
    this.process.onData((data) => {
      this.rawOutput += data;
      this.terminal.write(data);
    });
    this.exited = new Promise((resolve) => {
      this.process.onExit((event) => {
        this.exitEvent = event;
        resolve(event);
      });
    });
  }

  write(data: string): void {
    this.process.write(data);
  }

  resize(columns: number, rows: number): void {
    this.columns = columns;
    this.rows = rows;
    this.terminal.resize(columns, rows);
    this.process.resize(columns, rows);
  }

  screen(): string {
    const buffer = this.terminal.buffer.active;
    const lines: string[] = [];
    for (let index = 0; index < this.terminal.rows; index++) {
      lines.push(buffer.getLine(index)?.translateToString(true) ?? "");
    }
    return lines.join("\n");
  }

  output(): string {
    return this.rawOutput;
  }

  async waitFor(pattern: RegExp, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      // xterm.js processes writes asynchronously; yielding also lets its write
      // queue and the child process advance without fixed sleeps.
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      if (pattern.test(this.screen())) return;
      if (this.exitEvent) {
        throw new Error(
          `PTY exited before ${pattern}: ${JSON.stringify(this.exitEvent)}\n\nScreen:\n${this.screen()}\n\nRaw output:\n${this.rawOutput}`,
        );
      }
    }
    throw new Error(
      `Timed out waiting for ${pattern}.\n\nScreen:\n${this.screen()}\n\nRaw output tail:\n${this.rawOutput.slice(-4_000)}`,
    );
  }

  async waitForOutput(pattern: RegExp, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      if (pattern.test(this.rawOutput)) return;
      if (this.exitEvent) {
        throw new Error(
          `PTY exited before raw output ${pattern}: ${JSON.stringify(this.exitEvent)}\n\nRaw output:\n${this.rawOutput}`,
        );
      }
    }
    throw new Error(
      `Timed out waiting for raw output ${pattern}.\n\nRaw output tail:\n${this.rawOutput.slice(-4_000)}`,
    );
  }

  async waitForExit(timeoutMs = 5_000): Promise<ExitEvent> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.exited,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  `Timed out waiting for PTY exit.\n\nScreen:\n${this.screen()}\n\nRaw output tail:\n${this.rawOutput.slice(-4_000)}`,
                ),
              ),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.terminal.dispose();
    if (this.exitEvent) return;
    try {
      this.process.kill();
    } catch {
      // The process normally exited through the tested Ctrl+C path.
    }
  }
}

function spawnFixture(cwd: string, columns: number, rows: number): PtyHarness {
  const here = dirname(fileURLToPath(import.meta.url));
  const compiledFixture = join(here, "fixtures", "pty-app.js");
  const sourceFixture = join(here, "fixtures", "pty-app.ts");
  const compiled = existsSync(compiledFixture);
  const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");
  return new PtyHarness(
    process.execPath,
    compiled ? [compiledFixture] : [tsxCli, sourceFixture],
    cwd,
    columns,
    rows,
  );
}

if (process.env.NOVA_PTY_STANDALONE === "1") {
  let exitCode = 0;
  try {
    await runPtyScenario();
    process.stdout.write("PTY runtime scenario passed.\n");
  } catch (error) {
    exitCode = 1;
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
  }
  // `node-pty` closes Windows process-tree handles asynchronously. Let the
  // ConPTY process-list helper detach before removing its former cwd; deleting
  // that directory immediately can produce a transient EPERM/AttachConsole
  // race even after the tested child has emitted its exit event.
  await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
  if (scenarioTempDir) await removeTempDirectory(scenarioTempDir);
  await new Promise<void>((resolve) => setTimeout(resolve, 250));
  process.exit(exitCode);
} else {
  test("real PTY regression suite runs through npm run test:pty", {
    skip: "standalone PTY gate",
  });
}

async function removeTempDirectory(path: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EPERM" && code !== "EBUSY") throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
  }
  process.stderr.write(
    `Warning: could not remove PTY temp directory ${path}.\n`,
  );
}
