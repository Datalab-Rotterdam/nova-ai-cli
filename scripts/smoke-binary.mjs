// Runs a packed standalone binary the way a user would, from a folder without node_modules and with
// an empty home. CI runs this on each OS and CPU, so cross-compiled binaries are tested for real.
// Usage: node scripts/smoke-binary.mjs <archive> --version <v> [--tui]
// --tui also drives the interactive UI and the setup page, and needs the repo's npm dependencies.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs, promisify } from "node:util";
import { finish, say, startFakeNovaServer, toolCall } from "../test-support/fake-nova-server.ts";

const { values: options, positionals } = parseArgs({
  allowPositionals: true,
  options: { version: { type: "string" }, tui: { type: "boolean", default: false } },
});
const archive = resolve(positionals[0] ?? "");
assert.ok(existsSync(archive), `No archive at ${archive}`);
assert.ok(options.version, "--version is required");

const windows = process.platform === "win32";
const run = promisify(execFile);
const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "nova-smoke-")));
const folder = (name) => {
  const path = join(sandbox, name);
  mkdirSync(path, { recursive: true });
  return path;
};
const bin = folder("bin");
const home = folder("home");
const cwd = folder("workspace");

// The Windows tar reads zip too; a tar from Git for Windows, first on some PATHs, does not.
const tar = windows ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
await run(tar, ["-xf", archive, "-C", bin]);
const binary = join(bin, windows ? "nova-ai.exe" : "nova-ai");

const baseEnv = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  LOCALAPPDATA: join(home, "local"),
  XDG_CACHE_HOME: join(home, "cache"),
  NOVA_API_KEY: "smoke",
  NOVA_NO_UPDATE_CHECK: "1",
  NOVA_AI_BROWSER_AUTO_SETUP: "0",
};
delete baseEnv.NOVA_AI_HOME;
delete baseEnv.NOVA_BASE_URL;

function launch(args, env, input) {
  return new Promise((done, fail) => {
    const child = spawn(binary, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    const out = { stdout: "", stderr: "" };
    child.stdout.on("data", (data) => (out.stdout += data));
    child.stderr.on("data", (data) => (out.stderr += data));
    const timer = setTimeout(() => {
      child.kill();
      fail(new Error(`${args.join(" ")} timed out.\n${out.stdout}\n${out.stderr}`));
    }, 30_000);
    child.on("error", fail);
    child.on("exit", (code) => {
      clearTimeout(timer);
      done({ ...out, code });
    });
    child.stdin.end(input);
  });
}

/** `what` is text, or a function for what is only known at the end, like the screen. */
async function poll(check, what, ms = 15_000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const value = check();
    if (value) return value;
    await new Promise((wake) => setTimeout(wake, 50));
  }
  throw new Error(`Timed out waiting for ${typeof what === "function" ? what() : what}.`);
}

/** A check that hangs must fail like any other: this runs before a release, which waits for it. */
const CHECK_TIMEOUT_MS = 60_000;

function limited(check) {
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`No result after ${CHECK_TIMEOUT_MS / 1000}s.`)), CHECK_TIMEOUT_MS);
  });
  return Promise.race([check(), limit]).finally(() => clearTimeout(timer));
}

const checks = {
  async "--version and --help"() {
    const version = await launch(["--version"], baseEnv);
    assert.equal(version.code, 0, version.stderr);
    assert.equal(version.stdout.trim(), `nova-ai ${options.version}`);
    const help = await launch(["--help"], baseEnv);
    assert.equal(help.code, 0, help.stderr);
    assert.match(help.stdout, /nova-ai -p/);
  },

  // Loads the whole agent, which fails if a dependency reads its own files at import time.
  async "--acp answers initialize and installs the bundled skills"() {
    const child = spawn(binary, ["--acp"], { cwd, env: baseEnv, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => (stdout += data));
    child.stderr.on("data", (data) => (stderr += data));
    try {
      child.stdin.write(`${JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: 1, clientCapabilities: {} },
      })}\n`);
      const line = await poll(() => stdout.split("\n").find((entry) => entry.includes('"id":1')), `the initialize reply (${stderr})`);
      const agent = JSON.parse(line).result.agentInfo;
      assert.notEqual(agent.version, "0.0.0", "the agent version was not embedded");
      await poll(() => existsSync(join(home, ".nova-ai", "skills", "nova-docx", "SKILL.md")), "the bundled skills");
    } finally {
      child.kill();
    }
  },

  // Bun loads .env and bunfig.toml by default; the REAL variable shows the tool would reveal a leak.
  async "-p runs a tool, and files in the workspace do not configure the binary"() {
    writeFileSync(join(cwd, ".env"), "NOVA_SMOKE_DOTENV=leaked\n");
    const nova = await startFakeNovaServer([
      { chunks: [toolCall("c1", "run_command", { command: windows ? "set" : "env" }), finish("tool_calls")] },
      { chunks: [say("smoke-done")] },
    ]);
    try {
      const result = await launch(
        ["-p", "go", "--output-format", "json", "--permission-mode", "bypass-all"],
        { ...baseEnv, NOVA_BASE_URL: nova.url, NOVA_SMOKE_REAL: "present" },
      );
      assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
      assert.equal(JSON.parse(result.stdout).text, "smoke-done");
      const seen = JSON.stringify(nova.requests[1]?.messages ?? []);
      assert.match(seen, /NOVA_SMOKE_REAL=present/);
      assert.doesNotMatch(seen, /NOVA_SMOKE_DOTENV/);
    } finally {
      await nova.close();
    }
  },

  // Written after the checks above: the setup page and the rest are unpacked once.
  async "the assets unpack into the per-user cache"() {
    const cache = join(
      ...(windows ? [home, "local", "nova-ai", "cache"]
        : process.platform === "darwin" ? [home, "Library", "Caches", "nova-ai"]
          : [home, "cache", "nova-ai"]),
      "runtime",
    );
    const [copy, ...others] = readdirSync(cache).filter((entry) => !entry.startsWith("."));
    assert.ok(copy, "nothing was unpacked");
    assert.deepEqual(others, []);
    for (const path of ["setup-ui/index.html", "skills/nova-docx/SKILL.md", "browser-host/dist/cli.js"]) {
      assert.ok(existsSync(join(cache, copy, ...path.split("/"))), `${path} is missing`);
    }
  },
};

/** The terminal side, only with --tui: Ink under a real PTY, then the browser sign-in page. */
function tuiChecks() {
  const require = createRequire(import.meta.url);
  const pty = require("node-pty");
  const { Terminal } = require("@xterm/headless");

  function open(args, env) {
    const term = new Terminal({ cols: 90, rows: 24, allowProposedApi: true });
    const child = pty.spawn(binary, args, { name: "xterm-256color", cols: 90, rows: 24, cwd, env });
    const state = { exit: null };
    child.onData((data) => term.write(data));
    child.onExit((event) => (state.exit = event));
    // Answer the app's terminal queries like a real terminal. Without this the TUI takes a
    // timeout path no user gets, which hid a bug that left the prompt dead in every terminal.
    term.onData((reply) => {
      if (!state.exit) child.write(reply);
    });
    const screen = () => {
      const lines = [];
      for (let row = 0; row < term.buffer.active.length; row++) {
        lines.push(term.buffer.active.getLine(row).translateToString(true));
      }
      return lines.join("\n");
    };
    return { child, state, screen };
  }

  return {
    async "the TUI opens, answers and exits"() {
      const nova = await startFakeNovaServer([{ chunks: [say("tui-reply")] }]);
      const { child, state, screen } = open([], { ...baseEnv, NOVA_BASE_URL: nova.url });
      try {
        await poll(() => /\| ready\b/i.test(screen()), () => `the TUI\n${screen()}`);
        await new Promise((wake) => setTimeout(wake, 500));
        child.write("hello");
        await poll(() => /> *hello/.test(screen()), () => `the typed text\n${screen()}`);
        child.write("\r");
        await poll(() => /tui-reply/.test(screen()), () => `the reply\n${screen()}`);
        child.write("\u0003");
        await new Promise((wake) => setTimeout(wake, 300));
        child.write("\u0003");
        await poll(() => state.exit, () => `the TUI to exit\n${screen()}`);
        assert.equal(state.exit.exitCode, 0);
      } finally {
        if (!state.exit) child.kill();
        await nova.close();
      }
    },

    // No real browser may open. An empty PATH is not enough: the OS falls back to a default
    // one, so PATH holds stubs, which also show the command was called. Windows has no way
    // to replace rundll32, but CI has no browser. Ctrl+C ends login because node-pty's kill
    // can leave the process unable to exit on Windows.
    async "login serves the setup page"() {
      const stubs = folder("stubs");
      const opened = join(sandbox, "opened");
      for (const name of ["open", "xdg-open"]) {
        writeFileSync(join(stubs, name), `#!/bin/sh\nprintf %s "$1" > "${opened}"\n`, { mode: 0o755 });
      }
      const { child, state, screen } = open(["login"], { ...baseEnv, NOVA_API_KEY: "", PATH: stubs });
      try {
        const url = await poll(() => /http:\/\/127\.0\.0\.1:\d+/.exec(screen())?.[0], () => `the login URL\n${screen()}`);
        const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
        assert.equal(response.status, 200);
        assert.match(await response.text(), /<html/i);
        if (!windows) await poll(() => existsSync(opened), "the browser command");
        child.write("\u0003");
        await poll(() => state.exit, () => `login to stop\n${screen()}`, 5_000);
      } finally {
        if (!state.exit) child.kill();
      }
    },
  };
}

let failed = false;
for (const [name, check] of Object.entries({ ...checks, ...(options.tui ? tuiChecks() : {}) })) {
  console.log(`run   ${name}`);
  try {
    await limited(check);
    console.log(`ok    ${name}`);
  } catch (error) {
    failed = true;
    console.error(`FAIL  ${name}\n${error instanceof Error ? error.stack : error}`);
  }
}
console.log(failed ? "Failed." : "All checks passed.");
// Runs before a release, so a leftover process or folder must not fail or hang CI.
try {
  rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
} catch {
  // Windows may still hold the binary for a moment.
}
process.exit(failed ? 1 : 0);
