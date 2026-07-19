import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import type { AgentEvent } from "../core/agent-events.js";

export type BackgroundJobKind = "terminal" | "prompt";
export type BackgroundJobStatus =
  "running" | "completed" | "failed" | "killed" | "released";

export type BackgroundJobSummary = {
  jobId: string;
  sessionId: string;
  kind: BackgroundJobKind;
  title: string;
  status: BackgroundJobStatus;
  createdAt: string;
  updatedAt: string;
  terminalId?: string;
  outputPath?: string;
  exitCode?: number | null;
  signal?: string | null;
  error?: string;
};

type TerminalJob = BackgroundJobSummary & {
  kind: "terminal";
  command: string;
  terminalId: string;
};

type PromptJob = BackgroundJobSummary & {
  kind: "prompt";
  abortController: AbortController;
  output: string;
  events: AgentEvent[];
};

export type BackgroundJob = TerminalJob | PromptJob;

export type StartTerminalParams = {
  sessionId: string;
  command: string;
  title?: string;
};

export type StartPromptParams = {
  sessionId: string;
  prompt: acp.ContentBlock[];
  title?: string;
};

export type JobIdParams = {
  jobId: string;
};

export type ListParams = {
  sessionId?: string;
};

export type OutputResponse = {
  job: BackgroundJobSummary;
  output: string;
  truncated: boolean;
  outputPath?: string;
};

export type BackgroundWaitMode = "all" | "first";

export type WaitForBackgroundJobsOptions = {
  returnWhen: BackgroundWaitMode;
  timeoutMs: number;
  signal?: AbortSignal;
};

export type BackgroundJobWaitResult = {
  timedOut: boolean;
  jobs: BackgroundJobSummary[];
};

export type BackgroundToolWaitResult = BackgroundJobWaitResult & {
  returnWhen: BackgroundWaitMode;
  outputs: OutputResponse[];
};

export type BackgroundToolApi = {
  startCommand(command: string, title?: string): Promise<BackgroundJobSummary>;
  startAgent(prompt: string, title?: string): Promise<BackgroundJobSummary>;
  list(): BackgroundJobSummary[];
  output(jobId: string): Promise<OutputResponse>;
  wait(
    jobIds: string[],
    options: WaitForBackgroundJobsOptions,
  ): Promise<BackgroundToolWaitResult>;
  kill(jobId: string): Promise<BackgroundJobSummary>;
  release(jobId: string): Promise<BackgroundJobSummary>;
};

const DEFAULT_BACKGROUND_JOBS_DIR = join(
  homedir(),
  ".nova-ai",
  "background-jobs",
);

export class BackgroundJobManager {
  private readonly jobs = new Map<string, BackgroundJob>();
  private readonly statusListeners = new Set<() => void>();
  private readonly outputDir: string;

  constructor(outputDir?: string) {
    this.outputDir =
      outputDir ??
      process.env.NOVA_AI_CLI_BACKGROUND_JOBS_DIR ??
      DEFAULT_BACKGROUND_JOBS_DIR;
  }

  createPromptJob(params: {
    sessionId: string;
    title: string;
    abortController: AbortController;
  }): PromptJob {
    const now = new Date().toISOString();
    const jobId = crypto.randomUUID();
    const job: PromptJob = {
      jobId,
      sessionId: params.sessionId,
      kind: "prompt",
      title: params.title,
      status: "running",
      createdAt: now,
      updatedAt: now,
      outputPath: this.outputPath(jobId),
      abortController: params.abortController,
      output: "",
      events: [],
    };
    this.jobs.set(job.jobId, job);
    writeArtifact(this.outputDir, job, "");
    return job;
  }

  createTerminalJob(params: {
    sessionId: string;
    command: string;
    title: string;
    terminalId: string;
  }): TerminalJob {
    const now = new Date().toISOString();
    const jobId = crypto.randomUUID();
    const job: TerminalJob = {
      jobId,
      sessionId: params.sessionId,
      kind: "terminal",
      title: params.title,
      status: "running",
      createdAt: now,
      updatedAt: now,
      outputPath: this.outputPath(jobId),
      command: params.command,
      terminalId: params.terminalId,
    };
    this.jobs.set(job.jobId, job);
    writeArtifact(this.outputDir, job, "");
    return job;
  }

  get(jobId: string): BackgroundJob | undefined {
    return this.jobs.get(jobId);
  }

  list(sessionId?: string): BackgroundJobSummary[] {
    return [...this.jobs.values()]
      .filter((job) => !sessionId || job.sessionId === sessionId)
      .map((job) => summarize(job))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  waitForJobs(
    jobIds: string[],
    options: WaitForBackgroundJobsOptions,
  ): Promise<BackgroundJobWaitResult> {
    if (jobIds.length === 0) {
      throw new Error("At least one background job id is required.");
    }
    const current = () =>
      jobIds.map((jobId) => summarize(requireJob(this.jobs, jobId)));
    const isReady = (jobs: BackgroundJobSummary[]) =>
      options.returnWhen === "all"
        ? jobs.every((job) => job.status !== "running")
        : jobs.some((job) => job.status !== "running");
    const initial = current();
    if (isReady(initial))
      return Promise.resolve({ timedOut: false, jobs: initial });
    if (options.signal?.aborted)
      return Promise.reject(backgroundWaitAbortError());
    if (options.timeoutMs === 0)
      return Promise.resolve({ timedOut: true, jobs: initial });

    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        this.statusListeners.delete(onStatusChange);
        options.signal?.removeEventListener("abort", onAbort);
      };
      const settle = (result: BackgroundJobWaitResult) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };
      const onStatusChange = () => {
        const jobs = current();
        if (isReady(jobs)) settle({ timedOut: false, jobs });
      };
      const onAbort = () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(backgroundWaitAbortError());
      };

      this.statusListeners.add(onStatusChange);
      options.signal?.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(
        () => settle({ timedOut: true, jobs: current() }),
        options.timeoutMs,
      );

      // A job may have finished between the initial check and listener setup.
      if (options.signal?.aborted) onAbort();
      else onStatusChange();
    });
  }

  recordPromptEvent(jobId: string, event: AgentEvent): void {
    const job = this.jobs.get(jobId);
    if (!job || job.kind !== "prompt") return;
    job.events.push(event);
    if (event.type === "text") {
      job.output += event.text;
      appendArtifact(this.outputDir, job, event.text);
    }
    job.updatedAt = new Date().toISOString();
  }

  recordTerminalOutput(jobId: string, output: string): void {
    const job = this.jobs.get(jobId);
    if (!job || job.kind !== "terminal") return;
    writeArtifact(this.outputDir, job, output);
    job.updatedAt = new Date().toISOString();
  }

  finish(
    jobId: string,
    status: Exclude<BackgroundJobStatus, "running" | "released">,
    details: Partial<BackgroundJobSummary> = {},
  ): BackgroundJobSummary {
    const job = requireJob(this.jobs, jobId);
    job.status = status;
    job.updatedAt = new Date().toISOString();
    if ("exitCode" in details) job.exitCode = details.exitCode;
    if ("signal" in details) job.signal = details.signal;
    if ("error" in details) job.error = details.error;
    const summary = summarize(job);
    this.notifyStatusChange();
    return summary;
  }

  release(jobId: string): BackgroundJobSummary {
    const job = requireJob(this.jobs, jobId);
    job.status = "released";
    job.updatedAt = new Date().toISOString();
    const summary = summarize(job);
    this.notifyStatusChange();
    return summary;
  }

  private outputPath(jobId: string): string {
    return join(this.outputDir, `${jobId}.txt`);
  }

  private notifyStatusChange(): void {
    for (const listener of [...this.statusListeners]) listener();
  }
}

export function summarize(job: BackgroundJob): BackgroundJobSummary {
  const summary: BackgroundJobSummary = {
    jobId: job.jobId,
    sessionId: job.sessionId,
    kind: job.kind,
    title: job.title,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
  if (job.kind === "terminal") summary.terminalId = job.terminalId;
  if (job.outputPath) summary.outputPath = job.outputPath;
  if (job.exitCode !== undefined) summary.exitCode = job.exitCode;
  if (job.signal !== undefined) summary.signal = job.signal;
  if (job.error) summary.error = job.error;
  return summary;
}

function writeArtifact(
  outputDir: string,
  job: BackgroundJob,
  output: string,
): void {
  if (!job.outputPath) return;
  mkdirSync(outputDir, { recursive: true });
  const header = [
    `jobId: ${job.jobId}`,
    `sessionId: ${job.sessionId}`,
    `kind: ${job.kind}`,
    `title: ${job.title}`,
    `createdAt: ${job.createdAt}`,
    "",
  ].join("\n");
  writeFileSync(job.outputPath, `${header}${output}`, "utf8");
}

function appendArtifact(
  outputDir: string,
  job: BackgroundJob,
  text: string,
): void {
  if (!job.outputPath) return;
  mkdirSync(outputDir, { recursive: true });
  appendFileSync(job.outputPath, text, "utf8");
}

function requireJob(
  jobs: Map<string, BackgroundJob>,
  jobId: string,
): BackgroundJob {
  const job = jobs.get(jobId);
  if (!job) throw new Error(`Background job ${jobId} not found`);
  return job;
}

function backgroundWaitAbortError(): Error {
  const error = new Error("Background job wait canceled.");
  error.name = "AbortError";
  return error;
}

export function parseStartTerminalParams(params: unknown): StartTerminalParams {
  const value = requireRecord(params);
  const sessionId = requireString(value.sessionId, "sessionId");
  const command = requireString(value.command, "command");
  const title = optionalString(value.title, "title");
  return { sessionId, command, title };
}

export function parseStartPromptParams(params: unknown): StartPromptParams {
  const value = requireRecord(params);
  const sessionId = requireString(value.sessionId, "sessionId");
  if (!Array.isArray(value.prompt))
    throw new Error("prompt must be an array of ACP content blocks");
  const title = optionalString(value.title, "title");
  return { sessionId, prompt: value.prompt as acp.ContentBlock[], title };
}

export function parseJobIdParams(params: unknown): JobIdParams {
  const value = requireRecord(params);
  return { jobId: requireString(value.jobId, "jobId") };
}

export function parseListParams(params: unknown): ListParams {
  if (params == null) return {};
  const value = requireRecord(params);
  return { sessionId: optionalString(value.sessionId, "sessionId") };
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("params must be an object");
  return value as Record<string, unknown>;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`${name} must be a non-empty string`);
  return value;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return value || undefined;
}
