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
  waitForBackgroundJobsTool,
} from "../../../src/acp/tools/background.js";
import { makeToolContext } from "./test-helpers.js";

function makeBackground(
  overrides: Partial<BackgroundToolApi> = {},
): BackgroundToolApi {
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
    wait: async (jobIds, options) => ({
      timedOut: false,
      returnWhen: options.returnWhen,
      jobs: jobIds.map((jobId) => ({
        jobId,
        sessionId: "session-1",
        kind: "prompt",
        title: `agent ${jobId}`,
        status: "completed",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:01.000Z",
      })),
      outputs: jobIds.map((jobId) => ({
        job: {
          jobId,
          sessionId: "session-1",
          kind: "prompt",
          title: `agent ${jobId}`,
          status: "completed",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:01.000Z",
        },
        output: `done ${jobId}`,
        truncated: false,
        outputPath: `/tmp/${jobId}.txt`,
      })),
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
    const output = await readBackgroundOutputTool.execute(ctx, {
      jobId: "job-command",
    });

    assert.match("output" in list ? list.output : "", /job-command/);
    assert.match("output" in output ? output.output : "", /ready/);
  });

  it("kills and releases jobs", async () => {
    const ctx = makeToolContext({ background: makeBackground() });
    const killed = await killBackgroundJobTool.execute(ctx, {
      jobId: "job-command",
    });
    const released = await releaseBackgroundJobTool.execute(ctx, {
      jobId: "job-command",
    });

    assert.match("output" in killed ? killed.output : "", /killed/);
    assert.match("output" in released ? released.output : "", /released/);
  });

  it("waits for selected jobs and returns structured output previews", async () => {
    let received:
      | {
          jobIds: string[];
          returnWhen: string;
          timeoutMs: number;
          signal: AbortSignal | undefined;
        }
      | undefined;
    const background = makeBackground({
      wait: async (jobIds, options) => {
        received = {
          jobIds,
          returnWhen: options.returnWhen,
          timeoutMs: options.timeoutMs,
          signal: options.signal,
        };
        return {
          timedOut: false,
          returnWhen: options.returnWhen,
          jobs: [
            {
              jobId: jobIds[0]!,
              sessionId: "session-1",
              kind: "prompt",
              title: "review",
              status: "completed",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:01.000Z",
            },
          ],
          outputs: [
            {
              job: {
                jobId: jobIds[0]!,
                sessionId: "session-1",
                kind: "prompt",
                title: "review",
                status: "completed",
                createdAt: "2026-01-01T00:00:00.000Z",
                updatedAt: "2026-01-01T00:00:01.000Z",
              },
              output: "review complete",
              truncated: false,
              outputPath: "/tmp/job-agent.txt",
            },
          ],
        };
      },
    });
    const ctx = makeToolContext({ background });

    const result = await waitForBackgroundJobsTool.execute(ctx, {
      job_ids: [" job-agent ", "job-agent"],
      return_when: "first",
      timeout_ms: 123,
    });
    const output = JSON.parse("output" in result ? result.output : "{}") as {
      timed_out: boolean;
      return_when: string;
      jobs: Array<{
        job_id: string;
        status: string;
        output_preview: string;
      }>;
    };

    assert.deepEqual(received?.jobIds, ["job-agent"]);
    assert.equal(received?.returnWhen, "first");
    assert.equal(received?.timeoutMs, 123);
    assert.equal(received?.signal, ctx.signal);
    assert.equal(output.timed_out, false);
    assert.equal(output.return_when, "first");
    assert.deepEqual(output.jobs[0], {
      job_id: "job-agent",
      kind: "prompt",
      title: "review",
      status: "completed",
      output_preview: "review complete",
      output_truncated: false,
      output_path: "/tmp/job-agent.txt",
    });
  });

  it("validates wait bounds", async () => {
    const ctx = makeToolContext({ background: makeBackground() });

    assert.deepEqual(await waitForBackgroundJobsTool.execute(ctx, {}), {
      error: "wait_for_background_jobs requires a non-empty 'job_ids' array.",
    });
    assert.deepEqual(
      await waitForBackgroundJobsTool.execute(ctx, {
        job_ids: ["job-agent"],
        timeout_ms: 300_001,
      }),
      {
        error:
          "wait_for_background_jobs 'timeout_ms' must be an integer between 0 and 300000.",
      },
    );
  });

  it("returns timeout snapshots with a bounded tail preview", async () => {
    const longOutput = `${"x".repeat(4_000)}tail`;
    const background = makeBackground({
      wait: async (jobIds, options) => {
        const job = {
          jobId: jobIds[0]!,
          sessionId: "session-1",
          kind: "prompt" as const,
          title: "slow review",
          status: "running" as const,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:01.000Z",
        };
        return {
          timedOut: true,
          returnWhen: options.returnWhen,
          jobs: [job],
          outputs: [
            {
              job,
              output: longOutput,
              truncated: false,
            },
          ],
        };
      },
    });

    const result = await waitForBackgroundJobsTool.execute(
      makeToolContext({ background }),
      { job_ids: ["job-agent"], timeout_ms: 0 },
    );
    const output = JSON.parse("output" in result ? result.output : "{}") as {
      timed_out: boolean;
      jobs: Array<{ output_preview: string; output_truncated: boolean }>;
    };

    assert.equal(output.timed_out, true);
    assert.equal(output.jobs[0]?.output_truncated, true);
    assert.match(output.jobs[0]?.output_preview ?? "", /earlier characters omitted/);
    assert.equal(output.jobs[0]?.output_preview.endsWith("tail"), true);
    assert.equal((output.jobs[0]?.output_preview.length ?? 0) < longOutput.length, true);
  });

  it("errors when background jobs are unavailable", async () => {
    const result = await startBackgroundCommandTool.execute(makeToolContext(), {
      command: "npm run dev",
    });

    assert.deepEqual(result, {
      error: "Background jobs are not available in this session.",
    });
  });
});
