import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseCli, parseTuiArgs } from "../src/cli.js";
import { parseHeadlessArgs } from "../src/headless/index.js";

describe("parseCli", () => {
  it("picks the mode from whole arguments only", () => {
    assert.deepEqual(parseCli([]), { mode: "tui", args: [] });
    assert.deepEqual(parseCli(["-p", "fix the tests"]), { mode: "print", args: ["-p", "fix the tests"] });
    assert.deepEqual(parseCli(["--headless", "--prompt", "x"]), { mode: "print", args: ["--prompt", "x"] });
    // A prompt that mentions a flag is still just a prompt.
    assert.deepEqual(parseCli(["-p", "explain --acp"]), { mode: "print", args: ["-p", "explain --acp"] });
    assert.deepEqual(parseCli(["--acp"]), { mode: "acp", args: [] });
    assert.deepEqual(parseCli(["login", "--no-browser"]), { mode: "login", args: ["--no-browser"] });
    assert.deepEqual(parseCli(["--setup"]), { mode: "login", args: [] });
    assert.deepEqual(parseCli(["logout"]), { mode: "logout", args: [] });
    assert.deepEqual(parseCli(["--version"]), { mode: "version", args: [] });
  });

  it("routes --help to the selected mode", () => {
    assert.deepEqual(parseCli(["--help"]), { mode: "help", args: [] });
    assert.deepEqual(parseCli(["-p", "--help"]), { mode: "print", args: ["-p", "--help"] });
  });

  it("rejects two modes and ignores mode flags after --", () => {
    assert.equal(parseCli(["--acp", "-p", "x"]).mode, "error");
    assert.deepEqual(parseCli(["-p", "--", "--acp"]), { mode: "print", args: ["-p", "--", "--acp"] });
  });
});

describe("parseTuiArgs", () => {
  it("accepts resume, continue and model", () => {
    assert.deepEqual(parseTuiArgs(["--resume", "abc"]), { resume: "abc", continueLast: false, model: null });
    assert.deepEqual(parseTuiArgs(["-c", "--model=m"]), { resume: null, continueLast: true, model: "m" });
    assert.throws(() => parseTuiArgs(["--resume", "a", "--continue"]), /either/);
    assert.throws(() => parseTuiArgs(["--bogus"]), /Unknown option/);
    assert.throws(() => parseTuiArgs(["--model"]), /requires a value/);
  });
});

describe("headless arguments", () => {
  it("treats -p as the mode flag with an optional prompt", () => {
    assert.equal(parseHeadlessArgs(["-p", "do it"], process.cwd()).prompt, "do it");
    assert.equal(parseHeadlessArgs(["-p", "--output-format", "json"], process.cwd()).prompt, null);
    assert.equal(parseHeadlessArgs(["-p", "--json", "do", "it"], process.cwd()).prompt, "do it");
    assert.equal(parseHeadlessArgs(["--output-format=json", "x"], process.cwd()).outputFormat, "json");
    assert.equal(parseHeadlessArgs(["-c", "x"], process.cwd()).continueLast, true);
    assert.throws(() => parseHeadlessArgs(["--output-format", "xml"], process.cwd()), /Unknown output format/);
    assert.throws(() => parseHeadlessArgs(["--continue", "--resume", "a", "x"], process.cwd()), /either/);
  });
});

describe("nova-ai binary", () => {
  const run = async (args: string[]) => {
    const { spawnSync } = await import("node:child_process");
    const { fileURLToPath } = await import("node:url");
    const entry = fileURLToPath(new URL("../src/index.js", import.meta.url));
    // stdin/stdout are pipes here, exactly like a script or CI job.
    return spawnSync(process.execPath, [entry, ...args], { encoding: "utf8", input: "" });
  };

  it("prints the version and help", async () => {
    const { readFileSync } = await import("node:fs");
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    const version = await run(["--version"]);
    assert.equal(version.status, 0);
    assert.equal(version.stdout.trim(), `nova-ai ${pkg.version}`);
    const help = await run(["--help"]);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /nova-ai -p \[options\] \[prompt\]/);
  });

  it("explains instead of starting the TUI without a terminal", async () => {
    const result = await run([]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /nova-ai -p/);
  });

  it("rejects conflicting modes as a usage error", async () => {
    const result = await run(["--acp", "-p", "x"]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Choose one mode/);
  });
});

describe("nova-ai -p process", () => {
  it("answers and exits promptly (no timers keeping the process alive)", async () => {
    const { spawn } = await import("node:child_process");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const { startFakeNovaServer, say } = await import("./acp/fake-nova-server.js");
    const nova = await startFakeNovaServer([{ chunks: [say("Done.")] }]);
    const home = mkdtempSync(join(tmpdir(), "nova-print-exit-"));
    try {
      const entry = fileURLToPath(new URL("../src/index.js", import.meta.url));
      const started = Date.now();
      const child = spawn(process.execPath, [entry, "-p", "hi", "--output-format", "json", "--cwd", home], {
        env: { ...process.env, NOVA_AI_HOME: home, NOVA_API_KEY: "k", NOVA_MODEL: "fake-model", NOVA_BASE_URL: nova.url },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      child.stdout!.on("data", (chunk) => (out += chunk));
      const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
      const elapsed = Date.now() - started;
      assert.equal(code, 0);
      assert.equal(JSON.parse(out.trim()).text, "Done.");
      // Below the agent's 2s shutdown grace: a timer left running on the
      // shutdown path (as happened once) makes this fail.
      assert.ok(elapsed < 1_900, `took ${elapsed}ms`);
    } finally {
      await nova.close();
    }
  });
});
