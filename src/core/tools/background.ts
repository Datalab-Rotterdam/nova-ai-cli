import type { BackgroundToolWaitResult } from "../background.js";
import type { ToolDefinition } from "./types.js";

export const startBackgroundCommandTool: ToolDefinition = {
  name: "start_background_command",
  description:
    "start a long-running shell command, such as a dev server, in the background and return its job id.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "shell command" },
      title: { type: "string", description: "optional label" },
    },
    required: ["command"],
  },
  isAvailable: ({ background }) => !!background,
  mutating: true,
  kind: "execute",
  async execute({ background }, args) {
    if (!background)
      return { error: "Background jobs are not available in this session." };
    const command = typeof args.command === "string" ? args.command : "";
    if (!command)
      return {
        error: "start_background_command requires a 'command' argument.",
      };
    const title = typeof args.title === "string" ? args.title : undefined;
    const job = await background.startCommand(command, title);
    return { output: formatJob(job) };
  },
};

export const startBackgroundAgentTool: ToolDefinition = {
  name: "start_background_agent",
  description:
    "start another Nova agent turn in the background and return its job id.",
  parameters: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "task prompt" },
      title: { type: "string", description: "optional label" },
    },
    required: ["prompt"],
  },
  isAvailable: ({ background }) => !!background,
  mutating: true,
  kind: "think",
  async execute({ background }, args) {
    if (!background)
      return { error: "Background jobs are not available in this session." };
    const prompt = typeof args.prompt === "string" ? args.prompt : "";
    if (!prompt)
      return { error: "start_background_agent requires a 'prompt' argument." };
    const title = typeof args.title === "string" ? args.title : undefined;
    const job = await background.startAgent(prompt, title);
    return { output: formatJob(job) };
  },
};

export const listBackgroundJobsTool: ToolDefinition = {
  name: "list_background_jobs",
  description:
    "list running and completed background command/agent jobs for this session.",
  parameters: { type: "object", properties: {} },
  isAvailable: ({ background }) => !!background,
  mutating: false,
  kind: "read",
  async execute({ background }) {
    if (!background)
      return { error: "Background jobs are not available in this session." };
    const jobs = background.list();
    if (jobs.length === 0) return { output: "No background jobs." };
    return { output: jobs.map(formatJob).join("\n\n") };
  },
};

export const readBackgroundOutputTool: ToolDefinition = {
  name: "read_background_output",
  description:
    "read stored agent output or current terminal output for a background job.",
  parameters: {
    type: "object",
    properties: {
      jobId: { type: "string", description: "background job id" },
    },
    required: ["jobId"],
  },
  isAvailable: ({ background }) => !!background,
  mutating: false,
  kind: "read",
  async execute({ background }, args) {
    if (!background)
      return { error: "Background jobs are not available in this session." };
    const jobId = typeof args.jobId === "string" ? args.jobId : "";
    if (!jobId)
      return { error: "read_background_output requires a 'jobId' argument." };
    const result = await background.output(jobId);
    const truncated = result.truncated ? "\n[output truncated]" : "";
    return {
      output: `${formatJob(result.job)}\n\n${result.output}${truncated}`,
    };
  },
};

const DEFAULT_BACKGROUND_WAIT_MS = 30_000;
const MAX_BACKGROUND_WAIT_MS = 300_000;
const MAX_BACKGROUND_WAIT_JOBS = 16;
const MAX_WAIT_OUTPUT_PREVIEW_CHARS = 12_000;

export const waitForBackgroundJobsTool: ToolDefinition = {
  name: "wait_for_background_jobs",
  description:
    'wait for background jobs without releasing them. Returns when all jobs finish by default, or when the first finishes; a timeout returns current statuses and bounded output previews instead of failing. Example: {"job_ids":["job-1","job-2"],"return_when":"all","timeout_ms":30000}.',
  parameters: {
    type: "object",
    properties: {
      job_ids: {
        type: "array",
        items: { type: "string" },
        description: "one to sixteen background job ids",
      },
      return_when: {
        type: "string",
        enum: ["all", "first"],
        default: "all",
        description: "return after all jobs finish or the first job finishes",
      },
      timeout_ms: {
        type: "integer",
        default: DEFAULT_BACKGROUND_WAIT_MS,
        description:
          "maximum wait in milliseconds; zero only checks current state",
      },
    },
    required: ["job_ids"],
  },
  isAvailable: ({ background }) => !!background,
  mutating: false,
  kind: "think",
  async execute({ background, signal }, args) {
    if (!background) {
      return { error: "Background jobs are not available in this session." };
    }
    if (!Array.isArray(args.job_ids) || args.job_ids.length === 0) {
      return {
        error: "wait_for_background_jobs requires a non-empty 'job_ids' array.",
      };
    }
    if (
      args.job_ids.some(
        (jobId) => typeof jobId !== "string" || jobId.trim().length === 0,
      )
    ) {
      return {
        error:
          "wait_for_background_jobs requires every entry in 'job_ids' to be a non-empty string.",
      };
    }
    const jobIds = [
      ...new Set(args.job_ids.map((jobId) => (jobId as string).trim())),
    ];
    if (jobIds.length > MAX_BACKGROUND_WAIT_JOBS) {
      return {
        error: `wait_for_background_jobs accepts at most ${MAX_BACKGROUND_WAIT_JOBS} job ids.`,
      };
    }
    const returnWhen = args.return_when ?? "all";
    if (returnWhen !== "all" && returnWhen !== "first") {
      return {
        error:
          "wait_for_background_jobs 'return_when' must be 'all' or 'first'.",
      };
    }
    const timeoutMs = args.timeout_ms ?? DEFAULT_BACKGROUND_WAIT_MS;
    if (
      typeof timeoutMs !== "number" ||
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 0 ||
      timeoutMs > MAX_BACKGROUND_WAIT_MS
    ) {
      return {
        error: `wait_for_background_jobs 'timeout_ms' must be an integer between 0 and ${MAX_BACKGROUND_WAIT_MS}.`,
      };
    }

    const result = await background.wait(jobIds, {
      returnWhen,
      timeoutMs,
      signal,
    });
    return { output: formatWaitResult(result) };
  },
};

export const killBackgroundJobTool: ToolDefinition = {
  name: "kill_background_job",
  description: "stop a running background command or agent job.",
  parameters: {
    type: "object",
    properties: {
      jobId: { type: "string", description: "background job id" },
    },
    required: ["jobId"],
  },
  isAvailable: ({ background }) => !!background,
  mutating: true,
  kind: "execute",
  async execute({ background }, args) {
    if (!background)
      return { error: "Background jobs are not available in this session." };
    const jobId = typeof args.jobId === "string" ? args.jobId : "";
    if (!jobId)
      return { error: "kill_background_job requires a 'jobId' argument." };
    const job = await background.kill(jobId);
    return { output: formatJob(job) };
  },
};

export const releaseBackgroundJobTool: ToolDefinition = {
  name: "release_background_job",
  description:
    "release background job resources; terminal jobs are killed by ACP release if still running.",
  parameters: {
    type: "object",
    properties: {
      jobId: { type: "string", description: "background job id" },
    },
    required: ["jobId"],
  },
  isAvailable: ({ background }) => !!background,
  mutating: true,
  kind: "execute",
  async execute({ background }, args) {
    if (!background)
      return { error: "Background jobs are not available in this session." };
    const jobId = typeof args.jobId === "string" ? args.jobId : "";
    if (!jobId)
      return { error: "release_background_job requires a 'jobId' argument." };
    const job = await background.release(jobId);
    return { output: formatJob(job) };
  },
};

function formatJob(job: {
  jobId: string;
  kind: string;
  title: string;
  status: string;
  terminalId?: string;
  outputPath?: string;
  exitCode?: number | null;
  signal?: string | null;
  error?: string;
}): string {
  return [
    `jobId: ${job.jobId}`,
    `kind: ${job.kind}`,
    `title: ${job.title}`,
    `status: ${job.status}`,
    job.terminalId ? `terminalId: ${job.terminalId}` : null,
    job.outputPath ? `outputPath: ${job.outputPath}` : null,
    job.exitCode !== undefined ? `exitCode: ${job.exitCode}` : null,
    job.signal ? `signal: ${job.signal}` : null,
    job.error ? `error: ${job.error}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

function formatWaitResult(result: BackgroundToolWaitResult): string {
  const outputByJob = new Map(
    result.outputs.map((output) => [output.job.jobId, output]),
  );
  const previewLimit = Math.min(
    3_000,
    Math.floor(MAX_WAIT_OUTPUT_PREVIEW_CHARS / result.jobs.length),
  );
  const jobs = result.jobs.map((job) => {
    const output = outputByJob.get(job.jobId);
    const preview = boundedOutputPreview(output?.output ?? "", previewLimit);
    return {
      job_id: job.jobId,
      kind: job.kind,
      title: job.title,
      status: job.status,
      ...(job.exitCode !== undefined ? { exit_code: job.exitCode } : {}),
      ...(job.signal ? { signal: job.signal } : {}),
      ...(job.error ? { error: job.error } : {}),
      output_preview: preview.text,
      output_truncated: Boolean(output?.truncated || preview.truncated),
      ...(output?.outputPath ? { output_path: output.outputPath } : {}),
    };
  });

  return JSON.stringify(
    {
      timed_out: result.timedOut,
      return_when: result.returnWhen,
      jobs,
    },
    null,
    2,
  );
}

function boundedOutputPreview(
  output: string,
  limit: number,
): { text: string; truncated: boolean } {
  if (output.length <= limit) return { text: output, truncated: false };
  const omitted = output.length - limit;
  return {
    text: `[${omitted} earlier characters omitted]\n${output.slice(-limit)}`,
    truncated: true,
  };
}
