import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  BackgroundJobManager,
  parseJobIdParams,
  parseListParams,
  parseStartPromptParams,
  parseStartTerminalParams,
  summarize,
} from "../../src/acp/background.js";

describe("background param parsers", () => {
  it("parses terminal start params", () => {
    assert.deepEqual(
      parseStartTerminalParams({
        sessionId: "s1",
        command: "npm run dev",
        title: "dev",
      }),
      {
        sessionId: "s1",
        command: "npm run dev",
        title: "dev",
      },
    );
  });

  it("rejects terminal start params without a command", () => {
    assert.throws(
      () => parseStartTerminalParams({ sessionId: "s1" }),
      /command/,
    );
  });

  it("parses prompt start params", () => {
    assert.deepEqual(
      parseStartPromptParams({
        sessionId: "s1",
        prompt: [{ type: "text", text: "hi" }],
      }),
      {
        sessionId: "s1",
        prompt: [{ type: "text", text: "hi" }],
        title: undefined,
      },
    );
  });

  it("parses job id and list params", () => {
    assert.deepEqual(parseJobIdParams({ jobId: "j1" }), { jobId: "j1" });
    assert.deepEqual(parseListParams(null), {});
    assert.deepEqual(parseListParams({ sessionId: "s1" }), { sessionId: "s1" });
  });
});

describe("BackgroundJobManager", () => {
  it("tracks prompt output and completion", () => {
    const outputDir = mkdtempSync(join(tmpdir(), "nova-background-"));
    const manager = new BackgroundJobManager(outputDir);
    const job = manager.createPromptJob({
      sessionId: "s1",
      title: "scan",
      abortController: new AbortController(),
    });

    manager.recordPromptEvent(job.jobId, { type: "text", text: "hello" });
    manager.recordPromptEvent(job.jobId, { type: "text", text: " world" });
    const completed = manager.finish(job.jobId, "completed");
    const stored = manager.get(job.jobId);

    assert.equal(stored?.status, "completed");
    assert.equal(stored?.kind === "prompt" ? stored.output : "", "hello world");
    assert.equal(completed.status, "completed");
    assert.equal(
      readFileSync(job.outputPath!, "utf8").endsWith("hello world"),
      true,
    );
    rmSync(outputDir, { recursive: true, force: true });
  });

  it("lists jobs by session", () => {
    const outputDir = mkdtempSync(join(tmpdir(), "nova-background-"));
    const manager = new BackgroundJobManager(outputDir);
    manager.createTerminalJob({
      sessionId: "s1",
      command: "npm run dev",
      title: "dev",
      terminalId: "t1",
    });
    manager.createTerminalJob({
      sessionId: "s2",
      command: "npm test",
      title: "test",
      terminalId: "t2",
    });

    assert.equal(manager.list("s1").length, 1);
    assert.equal(manager.list("s1")[0]?.title, "dev");
    assert.equal(manager.list().length, 2);
    rmSync(outputDir, { recursive: true, force: true });
  });

  it("summarizes terminal ids but omits prompt internals", () => {
    const outputDir = mkdtempSync(join(tmpdir(), "nova-background-"));
    const manager = new BackgroundJobManager(outputDir);
    const terminal = manager.createTerminalJob({
      sessionId: "s1",
      command: "npm run dev",
      title: "dev",
      terminalId: "t1",
    });
    const prompt = manager.createPromptJob({
      sessionId: "s1",
      title: "agent",
      abortController: new AbortController(),
    });

    assert.equal(summarize(terminal).terminalId, "t1");
    assert.equal("terminalId" in summarize(prompt), false);
    assert.equal("output" in summarize(prompt), false);
    assert.equal(summarize(prompt).outputPath?.startsWith(outputDir), true);
    rmSync(outputDir, { recursive: true, force: true });
  });

  it("waits until the first or all selected jobs finish", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "nova-background-"));
    const manager = new BackgroundJobManager(outputDir);
    const first = manager.createPromptJob({
      sessionId: "s1",
      title: "first",
      abortController: new AbortController(),
    });
    const second = manager.createPromptJob({
      sessionId: "s1",
      title: "second",
      abortController: new AbortController(),
    });

    const waitForFirst = manager.waitForJobs([first.jobId, second.jobId], {
      returnWhen: "first",
      timeoutMs: 1_000,
    });
    manager.finish(first.jobId, "completed");
    const firstResult = await waitForFirst;

    assert.equal(firstResult.timedOut, false);
    assert.equal(firstResult.jobs[0]?.status, "completed");
    assert.equal(firstResult.jobs[1]?.status, "running");

    const waitForAll = manager.waitForJobs([first.jobId, second.jobId], {
      returnWhen: "all",
      timeoutMs: 1_000,
    });
    manager.finish(second.jobId, "failed", { error: "failed" });
    const allResult = await waitForAll;

    assert.equal(allResult.timedOut, false);
    assert.deepEqual(
      allResult.jobs.map((job) => job.status),
      ["completed", "failed"],
    );
    rmSync(outputDir, { recursive: true, force: true });
  });

  it("returns current state on timeout", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "nova-background-"));
    const manager = new BackgroundJobManager(outputDir);
    const job = manager.createPromptJob({
      sessionId: "s1",
      title: "slow",
      abortController: new AbortController(),
    });

    const result = await manager.waitForJobs([job.jobId], {
      returnWhen: "all",
      timeoutMs: 5,
    });

    assert.equal(result.timedOut, true);
    assert.equal(result.jobs[0]?.status, "running");
    rmSync(outputDir, { recursive: true, force: true });
  });

  it("cancels an active wait through its abort signal", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "nova-background-"));
    const manager = new BackgroundJobManager(outputDir);
    const job = manager.createPromptJob({
      sessionId: "s1",
      title: "slow",
      abortController: new AbortController(),
    });
    const abortController = new AbortController();
    const waiting = manager.waitForJobs([job.jobId], {
      returnWhen: "all",
      timeoutMs: 1_000,
      signal: abortController.signal,
    });
    const rejected = assert.rejects(waiting, { name: "AbortError" });

    abortController.abort();
    await rejected;
    rmSync(outputDir, { recursive: true, force: true });
  });
});
