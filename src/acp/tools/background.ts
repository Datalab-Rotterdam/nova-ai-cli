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
    if (!background) return { error: "Background jobs are not available in this session." };
    const command = typeof args.command === "string" ? args.command : "";
    if (!command) return { error: "start_background_command requires a 'command' argument." };
    const title = typeof args.title === "string" ? args.title : undefined;
    const job = await background.startCommand(command, title);
    return { output: formatJob(job) };
  },
};

export const startBackgroundAgentTool: ToolDefinition = {
  name: "start_background_agent",
  description: "start another Nova agent turn in the background and return its job id.",
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
    if (!background) return { error: "Background jobs are not available in this session." };
    const prompt = typeof args.prompt === "string" ? args.prompt : "";
    if (!prompt) return { error: "start_background_agent requires a 'prompt' argument." };
    const title = typeof args.title === "string" ? args.title : undefined;
    const job = await background.startAgent(prompt, title);
    return { output: formatJob(job) };
  },
};

export const listBackgroundJobsTool: ToolDefinition = {
  name: "list_background_jobs",
  description: "list running and completed background command/agent jobs for this session.",
  parameters: { type: "object", properties: {} },
  isAvailable: ({ background }) => !!background,
  mutating: false,
  kind: "read",
  async execute({ background }) {
    if (!background) return { error: "Background jobs are not available in this session." };
    const jobs = background.list();
    if (jobs.length === 0) return { output: "No background jobs." };
    return { output: jobs.map(formatJob).join("\n\n") };
  },
};

export const readBackgroundOutputTool: ToolDefinition = {
  name: "read_background_output",
  description: "read stored agent output or current terminal output for a background job.",
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
    if (!background) return { error: "Background jobs are not available in this session." };
    const jobId = typeof args.jobId === "string" ? args.jobId : "";
    if (!jobId) return { error: "read_background_output requires a 'jobId' argument." };
    const result = await background.output(jobId);
    const truncated = result.truncated ? "\n[output truncated]" : "";
    return { output: `${formatJob(result.job)}\n\n${result.output}${truncated}` };
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
    if (!background) return { error: "Background jobs are not available in this session." };
    const jobId = typeof args.jobId === "string" ? args.jobId : "";
    if (!jobId) return { error: "kill_background_job requires a 'jobId' argument." };
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
    if (!background) return { error: "Background jobs are not available in this session." };
    const jobId = typeof args.jobId === "string" ? args.jobId : "";
    if (!jobId) return { error: "release_background_job requires a 'jobId' argument." };
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
