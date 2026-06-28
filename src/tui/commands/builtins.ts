import type { SlashCommand } from "./types.js";
import type { BackgroundJobKind, BackgroundJobSummary } from "../../acp/background.js";

const interactionModes = ["agent", "ask", "plan"] as const;
const permissionModes = ["ask", "acceptEdits", "bypassAll"] as const;

export const builtinCommands: SlashCommand[] = [
  {
    name: "help",
    description: "Show available commands",
    run(ctx) {
      const lines = builtinCommands.map((c) => `/${c.name} — ${c.description}`);
      ctx.print(lines.join("\n"));
    },
  },
  {
    name: "clear",
    description: "Start a new session (clears transcript and conversation history)",
    run(ctx) {
      void ctx.newSession();
    },
  },
  {
    name: "resume",
    description: "Resume the latest session, or /resume <session-id>",
    run(ctx, args) {
      const sessionId = args.trim() || undefined;
      if (!ctx.resumeSession(sessionId)) {
        ctx.print(sessionId ? `Session not found: ${sessionId}` : "No saved sessions for this workspace.");
      }
    },
  },
  {
    name: "sessions",
    description: "Browse and switch sessions",
    run(ctx) {
      ctx.openSessionSwitcher();
    },
  },
  {
    name: "exit",
    description: "Exit nova-ai-cli",
    run(ctx) {
      ctx.exit();
    },
  },
  {
    name: "mode",
    description: "Switch interaction mode (/mode agent|ask|plan)",
    run(ctx, args) {
      const mode = args.trim();
      if (!mode) {
        ctx.print(`Current mode: ${ctx.getInteractionMode()}`);
        return;
      }
      if (!interactionModes.includes(mode as (typeof interactionModes)[number])) {
        ctx.print("Usage: /mode agent|ask|plan");
        return;
      }
      ctx.setInteractionMode(mode as (typeof interactionModes)[number]);
    },
  },
  {
    name: "permission",
    description: "Switch permission mode (/permission ask|acceptEdits|bypassAll)",
    run(ctx, args) {
      const mode = args.trim();
      if (!mode) {
        ctx.openPermissionPicker();
        return;
      }
      if (!permissionModes.includes(mode as (typeof permissionModes)[number])) {
        ctx.print("Usage: /permission ask|acceptEdits|bypassAll");
        return;
      }
      ctx.setPermissionMode(mode as (typeof permissionModes)[number]);
    },
  },
  {
    name: "model",
    description: "Switch the active model (/model <id>, or no args to pick interactively)",
    run(ctx, args) {
      const id = args.trim();
      if (id) {
        ctx.setModel(id);
        ctx.print(`Switched model to ${id}.`);
        return;
      }
      ctx.openModelPicker();
    },
  },
  {
    name: "shell",
    description: "Manage background shell jobs (/shell run|ps|output|kill|release)",
    run(ctx, args) {
      void runBackgroundCommand(ctx, "terminal", args, {
        usage: "Usage: /shell run <command> | /shell ps | /shell output <jobId> | /shell kill <jobId|all> | /shell release <jobId|all>",
        start: (command) => ctx.startBackgroundShell(command),
      });
    },
  },
  {
    name: "agent",
    description: "Manage background agent jobs (/agent run|ps|output|kill|release)",
    run(ctx, args) {
      void runBackgroundCommand(ctx, "prompt", args, {
        usage: "Usage: /agent run <prompt> | /agent ps | /agent output <jobId> | /agent kill <jobId|all> | /agent release <jobId|all>",
        start: (prompt) => ctx.startBackgroundAgent(prompt),
      });
    },
  },
];

async function runBackgroundCommand(
  ctx: Parameters<SlashCommand["run"]>[0],
  kind: BackgroundJobKind,
  args: string,
  options: {
    usage: string;
    start(input: string): Promise<BackgroundJobSummary>;
  },
): Promise<void> {
  const trimmed = args.trim();
  const [subcommand, ...rest] = splitCommand(trimmed);
  const value = rest.join(" ").trim();

  try {
    switch (subcommand) {
      case "run": {
        if (!value) {
          ctx.print(options.usage);
          return;
        }
        const job = await options.start(value);
        ctx.print(`Started background ${kind === "terminal" ? "shell" : "agent"} job.\n${formatJob(job)}`);
        return;
      }
      case "":
      case "ps":
      case "list": {
        const jobs = await ctx.listBackgroundJobs(kind);
        ctx.print(jobs.length ? jobs.map(formatJob).join("\n\n") : `No background ${kind === "terminal" ? "shell" : "agent"} jobs.`);
        return;
      }
      case "output":
      case "out": {
        if (!value) {
          ctx.print(options.usage);
          return;
        }
        const result = await ctx.backgroundOutput(value);
        ctx.print(`${formatJob(result.job)}\n\n${result.output}${result.truncated ? "\n[output truncated]" : ""}`);
        return;
      }
      case "kill":
      case "stop": {
        await mutateJobs(ctx, kind, value, "kill");
        return;
      }
      case "release": {
        await mutateJobs(ctx, kind, value, "release");
        return;
      }
      default:
        ctx.print(options.usage);
    }
  } catch (err) {
    ctx.print(err instanceof Error ? err.message : "Background command failed.");
  }
}

async function mutateJobs(
  ctx: Parameters<SlashCommand["run"]>[0],
  kind: BackgroundJobKind,
  target: string,
  action: "kill" | "release",
): Promise<void> {
  if (!target) {
    ctx.print(`${action === "kill" ? "Kill" : "Release"} requires a job id or 'all'.`);
    return;
  }

  const jobs = target === "all" ? await ctx.listBackgroundJobs(kind) : (await ctx.listBackgroundJobs(kind)).filter((job) => job.jobId === target);
  if (jobs.length === 0) {
    ctx.print(target === "all" ? `No background ${kind === "terminal" ? "shell" : "agent"} jobs.` : `Background job not found: ${target}`);
    return;
  }

  const changed: BackgroundJobSummary[] = [];
  for (const job of jobs) {
    changed.push(action === "kill" ? await ctx.killBackgroundJob(job.jobId) : await ctx.releaseBackgroundJob(job.jobId));
  }
  ctx.print(changed.map(formatJob).join("\n\n"));
}

function splitCommand(input: string): string[] {
  if (!input) return [""];
  const firstSpace = input.search(/\s/);
  if (firstSpace === -1) return [input];
  return [input.slice(0, firstSpace), input.slice(firstSpace + 1)];
}

function formatJob(job: BackgroundJobSummary): string {
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
