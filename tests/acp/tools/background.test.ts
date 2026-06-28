import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BackgroundToolApi } from "../../../src/acp/background.js";
import {
  killBackgroundJobTool,
  listBackgroundJobsTool,
  readBackgroundOutputTool,
  releaseBackgroundJobTool,
  startBackgroundAgentTool,
  startBackgroundCommandTool,
} from "../../../src/acp/tools/background.js";
import { makeToolContext } from "./test-helpers.js";

function makeBackground(overrides: Partial<BackgroundToolApi> = {}): BackgroundToolApi {
  return {
    startCommand: async (command, title) => ({
      jobId: "job-command",
      sessionId: "session-1",
      kind: "terminal",
      title: title ?? command,
      status: "running",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      terminalId: "terminal-1",
      outputPath: "/tmp/job-command.txt",
    }),
    startAgent: async (_prompt, title) => ({
      jobId: "job-agent",
      sessionId: "session-1",
      kind: "prompt",
      title: title ?? "agent",
      status: "running",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      outputPath: "/tmp/job-agent.txt",
    }),
    list: () => [
      {
        jobId: "job-command",
        sessionId: "session-1",
        kind: "terminal",
        title: "dev",
        status: "running",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    output: async (jobId) => ({
      job: {
        jobId,
        sessionId: "session-1",
        kind: "terminal",
        title: "dev",
        status: "running",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      output: "ready",
      truncated: false,
      outputPath: "/tmp/job-command.txt",
    }),
    kill: async (jobId) => ({
      jobId,
      sessionId: "session-1",
      kind: "terminal",
      title: "dev",
      status: "killed",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }),
    release: async (jobId) => ({
      jobId,
      sessionId: "session-1",
      kind: "terminal",
      title: "dev",
      status: "released",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }),
    ...overrides,
  };
}

describe("background tools", () => {
  it("starts a background command", async () => {
    const result = await startBackgroundCommandTool.execute(
      makeToolContext({ background: makeBackground() }),
      { command: "npm run dev", title: "dev" },
    );

    assert.equal("output" in result, true);
    assert.match("output" in result ? result.output : "", /job-command/);
    assert.match("output" in result ? result.output : "", /terminal-1/);
  });

  it("starts a background agent", async () => {
    const result = await startBackgroundAgentTool.execute(
      makeToolContext({ background: makeBackground() }),
      { prompt: "review tests", title: "review" },
    );

    assert.equal("output" in result, true);
    assert.match("output" in result ? result.output : "", /job-agent/);
  });

  it("lists jobs and reads output", async () => {
    const ctx = makeToolContext({ background: makeBackground() });
    const list = await listBackgroundJobsTool.execute(ctx, {});
    const output = await readBackgroundOutputTool.execute(ctx, { jobId: "job-command" });

    assert.match("output" in list ? list.output : "", /job-command/);
    assert.match("output" in output ? output.output : "", /ready/);
  });

  it("kills and releases jobs", async () => {
    const ctx = makeToolContext({ background: makeBackground() });
    const killed = await killBackgroundJobTool.execute(ctx, { jobId: "job-command" });
    const released = await releaseBackgroundJobTool.execute(ctx, { jobId: "job-command" });

    assert.match("output" in killed ? killed.output : "", /killed/);
    assert.match("output" in released ? released.output : "", /released/);
  });

  it("errors when background jobs are unavailable", async () => {
    const result = await startBackgroundCommandTool.execute(makeToolContext(), { command: "npm run dev" });

    assert.deepEqual(result, { error: "Background jobs are not available in this session." });
  });
});
