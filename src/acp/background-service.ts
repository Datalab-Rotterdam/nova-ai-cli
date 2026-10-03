import * as acp from "@agentclientprotocol/sdk";
import { NovaAI, type ChatMessage } from "@datalabrotterdam/nova-sdk";
import { createNovaClient } from "../core/nova-client.js";
import type { AgentEvent } from "../core/agent-events.js";
import { buildModeSystemPrompt } from "../core/agent/mode-prompt.js";
import type { Session } from "../core/agent/session.js";
import { buildSessionTools } from "../core/agent/session-tools.js";
import {
  BackgroundJobManager,
  summarize,
  type BackgroundJobSummary,
  type BackgroundToolApi,
  type JobIdParams,
  type ListParams,
  type OutputResponse,
  type StartPromptParams,
  type StartTerminalParams,
} from "../core/background.js";
import { chatContentToText } from "../core/chat-content.js";
import { readCredentials } from "../core/credentials.js";
import { buildMemorySystemPrompt, loadMemory } from "../core/memory.js";
import { stripReasoningTags } from "../core/reasoning-tags.js";
import { runTurn } from "../core/run-turn.js";
import { deriveTitle } from "../core/sessions.js";
import { buildSkillsSystemPrompt, discoverSkills } from "../core/skills.js";
import { detectToolEnvironment } from "../core/tools/environment.js";
import { stripToolCallMarkup } from "../core/tools/marker.js";
import {
  buildNativeToolsSystemPrompt,
  buildToolsSystemPrompt,
} from "../core/tools/system-prompt.js";
import {
  chooseToolProtocol,
  runWithToolProtocol,
  type ToolProtocol,
} from "../core/agent/tool-protocol.js";
import type { ToolDefinition } from "../core/tools/types.js";
import { truncateToolOutput } from "../core/tool-output.js";
import { AcpToolHost } from "./acp-tool-host.js";
import { emitBackgroundUpdate } from "./acp-emit.js";
import { authorizeToolCall } from "./permission-flow.js";
import type { AgentRuntime } from "./agent-runtime.js";
import {
  contentBlocksToNovaContent,
  contentBlocksToText,
  getPromptMode,
} from "./prompt-content.js";

/** Background terminal and agent jobs (Nova extension methods). */
export class BackgroundService {
  readonly backgroundJobs = new BackgroundJobManager();

  constructor(private readonly runtime: AgentRuntime) {}

  async startBackgroundTerminal(
    params: StartTerminalParams,
    client: acp.AgentContext,
  ): Promise<{ job: BackgroundJobSummary }> {
    const session = this.runtime.requireSession(params.sessionId);
    if (!this.runtime.clientCapabilities?.terminal) {
      throw new Error(
        "background/start_terminal requires ACP terminal client capability.",
      );
    }

    const created = await client.request(acp.methods.client.terminal.create, {
      sessionId: params.sessionId,
      command: params.command,
      cwd: session.cwd,
      outputByteLimit: 1_000_000,
    });
    const job = this.backgroundJobs.createTerminalJob({
      sessionId: params.sessionId,
      command: params.command,
      title: params.title ?? params.command,
      terminalId: created.terminalId,
    });

    await emitBackgroundUpdate(client, "started", summarize(job));
    void this.watchTerminalJob(client, job.jobId, session.cwd);
    return { job: summarize(job) };
  }

  createBackgroundToolApi(
    sessionId: string,
    client: acp.AgentContext,
  ): BackgroundToolApi {
    return {
      startCommand: async (command, title) => {
        const response = await this.startBackgroundTerminal(
          { sessionId, command, title },
          client,
        );
        return response.job;
      },
      startAgent: async (prompt, title) => {
        const response = await this.startBackgroundPrompt(
          { sessionId, prompt: [{ type: "text", text: prompt }], title },
          client,
        );
        return response.job;
      },
      list: () => this.backgroundJobs.list(sessionId),
      output: (jobId) => this.backgroundOutput({ jobId }, client),
      wait: async (jobIds, options) => {
        for (const jobId of jobIds) {
          const job = this.backgroundJobs.get(jobId);
          if (!job || job.sessionId !== sessionId) {
            throw new Error(`Background job ${jobId} not found`);
          }
        }
        const waited = await this.backgroundJobs.waitForJobs(jobIds, options);
        const outputs = await Promise.all(
          jobIds.map((jobId) => this.backgroundOutput({ jobId }, client)),
        );
        return {
          timedOut: waited.timedOut,
          returnWhen: options.returnWhen,
          jobs: outputs.map((result) => result.job),
          outputs,
        };
      },
      kill: async (jobId) => {
        const response = await this.killBackgroundJob({ jobId }, client);
        return response.job;
      },
      release: async (jobId) => {
        const response = await this.releaseBackgroundJob({ jobId }, client);
        return response.job;
      },
    };
  }

  async startBackgroundPrompt(
    params: StartPromptParams,
    client: acp.AgentContext,
  ): Promise<{ job: BackgroundJobSummary }> {
    const session = this.runtime.requireSession(params.sessionId);
    const credentials = readCredentials();
    if (!credentials) {
      throw acp.RequestError.authRequired();
    }

    const model =
      session.model ?? credentials.defaultModel ?? process.env.NOVA_MODEL;
    if (!model) {
      throw new Error(
        "No Nova model configured. Re-run authentication or set NOVA_MODEL.",
      );
    }

    // Fail the request before a job exists rather than emitting a phantom
    // started→failed job for an unsupported prompt.
    const novaClient = createNovaClient(credentials.apiKey);
    await this.runtime.models.assertImageInputSupported(novaClient, model, params.prompt);

    const abortController = new AbortController();
    const job = this.backgroundJobs.createPromptJob({
      sessionId: params.sessionId,
      title:
        params.title ??
        deriveTitle([
          { role: "user", content: contentBlocksToText(params.prompt) },
        ]) ??
        "Background prompt",
      abortController,
    });

    await emitBackgroundUpdate(client, "started", summarize(job));
    void this.runBackgroundPrompt(
      job.jobId,
      params,
      client,
      abortController,
      novaClient,
      model,
      session,
    ).catch(async (err) => {
      const current = this.backgroundJobs.get(job.jobId);
      if (!current || current.status !== "running") return;
      const summary = this.backgroundJobs.finish(job.jobId, "failed", {
        error: err instanceof Error ? err.message : "Background prompt failed.",
      });
      await emitBackgroundUpdate(client, "failed", summary).catch(() => {});
    });

    return { job: summarize(job) };
  }

  listBackgroundJobs(params: ListParams): { jobs: BackgroundJobSummary[] } {
    return { jobs: this.backgroundJobs.list(params.sessionId) };
  }

  async backgroundOutput(
    params: JobIdParams,
    client: acp.AgentContext,
  ): Promise<OutputResponse> {
    const job = this.backgroundJobs.get(params.jobId);
    if (!job) throw new Error(`Background job ${params.jobId} not found`);
    if (job.kind === "prompt") {
      return {
        job: summarize(job),
        output: job.output,
        truncated: false,
        outputPath: job.outputPath,
      };
    }

    const output = await client.request(acp.methods.client.terminal.output, {
      sessionId: job.sessionId,
      terminalId: job.terminalId,
    });
    this.backgroundJobs.recordTerminalOutput(job.jobId, output.output);
    if (output.exitStatus && job.status === "running") {
      this.backgroundJobs.finish(
        job.jobId,
        output.exitStatus.exitCode === 0 ? "completed" : "failed",
        {
          exitCode: output.exitStatus.exitCode ?? null,
          signal: output.exitStatus.signal ?? null,
        },
      );
    }
    return {
      job: summarize(job),
      output: output.output,
      truncated: output.truncated,
      outputPath: job.outputPath,
    };
  }

  async killBackgroundJob(
    params: JobIdParams,
    client: acp.AgentContext,
  ): Promise<{ job: BackgroundJobSummary }> {
    const job = this.backgroundJobs.get(params.jobId);
    if (!job) throw new Error(`Background job ${params.jobId} not found`);

    if (job.kind === "prompt") {
      job.abortController.abort();
    } else if (job.status === "running") {
      await client.request(acp.methods.client.terminal.kill, {
        sessionId: job.sessionId,
        terminalId: job.terminalId,
      });
    }

    const summary = this.backgroundJobs.finish(params.jobId, "killed", {
      signal: "killed",
    });
    await emitBackgroundUpdate(client, "killed", summary);
    return { job: summary };
  }

  async releaseBackgroundJob(
    params: JobIdParams,
    client: acp.AgentContext,
  ): Promise<{ job: BackgroundJobSummary }> {
    const job = this.backgroundJobs.get(params.jobId);
    if (!job) throw new Error(`Background job ${params.jobId} not found`);

    if (job.kind === "terminal") {
      await client.request(acp.methods.client.terminal.release, {
        sessionId: job.sessionId,
        terminalId: job.terminalId,
      });
    } else if (job.status === "running") {
      job.abortController.abort();
    }

    const summary = this.backgroundJobs.release(params.jobId);
    await emitBackgroundUpdate(client, "released", summary);
    return { job: summary };
  }

  private async watchTerminalJob(
    client: acp.AgentContext,
    jobId: string,
    cwd: string,
  ): Promise<void> {
    const job = this.backgroundJobs.get(jobId);
    if (!job || job.kind !== "terminal") return;
    try {
      const exit = await client.request(
        acp.methods.client.terminal.waitForExit,
        {
          sessionId: job.sessionId,
          terminalId: job.terminalId,
        },
      );
      const current = this.backgroundJobs.get(jobId);
      if (!current || current.status !== "running") return;
      const output = await client.request(acp.methods.client.terminal.output, {
        sessionId: job.sessionId,
        terminalId: job.terminalId,
      });
      this.backgroundJobs.recordTerminalOutput(jobId, output.output);
      const status = exit.exitCode === 0 ? "completed" : "failed";
      const summary = this.backgroundJobs.finish(jobId, status, {
        exitCode: exit.exitCode ?? null,
        signal: exit.signal ?? null,
      });
      await emitBackgroundUpdate(client, status, summary, { cwd });
    } catch (err) {
      const current = this.backgroundJobs.get(jobId);
      if (!current || current.status !== "running") return;
      const summary = this.backgroundJobs.finish(jobId, "failed", {
        error:
          err instanceof Error ? err.message : "Background terminal failed.",
      });
      await emitBackgroundUpdate(client, "failed", summary, { cwd }).catch(
        () => {},
      );
    }
  }

  private async runBackgroundPrompt(
    jobId: string,
    params: StartPromptParams,
    client: acp.AgentContext,
    abortController: AbortController,
    novaClient: NovaAI,
    model: string,
    session: Session,
  ): Promise<void> {
    session.environment = await detectToolEnvironment(
      session.cwd,
      this.runtime.clientCapabilities,
    );
    session.skills = discoverSkills(session.cwd);
    session.memory = loadMemory(session.cwd);
    const contextWindow = await this.runtime.models.resolveContextWindow(
      novaClient,
      model,
    );
    const background = this.createBackgroundToolApi(params.sessionId, client);
    const tools = buildSessionTools(session, this.runtime.clientCapabilities, {
      mode: null,
    });
    const systemPromptFor = (protocol: ToolProtocol) =>
      [
        buildModeSystemPrompt(getPromptMode(params)),
        buildSkillsSystemPrompt(session.skills),
        buildMemorySystemPrompt(session.memory),
        protocol === "native"
          ? buildNativeToolsSystemPrompt(tools, session.cwd)
          : buildToolsSystemPrompt(tools, session.cwd),
      ]
        .filter(Boolean)
        .join("\n\n");
    const systemPrompt = systemPromptFor(
      chooseToolProtocol(model, this.runtime.models.toolSupport, tools.length > 0),
    );
    const userMessage: ChatMessage = {
      role: "user",
      content: contentBlocksToNovaContent(params.prompt),
    };
    // Snapshot: a concurrent foreground turn keeps mutating session.history,
    // and this job must never see or produce interleaved state.
    const messages: ChatMessage[] = [
      ...(systemPrompt
        ? [{ role: "system" as const, content: systemPrompt }]
        : []),
      ...session.history,
      userMessage,
    ];
    const host = new AcpToolHost(client, params.sessionId);
    const authorize = (
      toolCallId: string,
      tool: ToolDefinition,
      args: Record<string, unknown>,
    ) =>
      authorizeToolCall(
        {
          client,
          sessionId: params.sessionId,
          cwd: session.cwd,
          host,
          policy: session.policy,
          signal: abortController.signal,
        },
        toolCallId,
        tool,
        args,
      );
    const requestPermission = async (
      toolCallId: string,
      tool: ToolDefinition,
      args: Record<string, unknown>,
    ) => (await authorize(toolCallId, tool, args)).allowed;
    const emit = async (event: AgentEvent) => {
      this.backgroundJobs.recordPromptEvent(jobId, event);
    };

    let turnMessages: ChatMessage[] = [];
    let completedNormally = false;
    try {
      const result = await runWithToolProtocol({
        model,
        support: this.runtime.models.toolSupport,
        hasTools: tools.length > 0,
        run: (toolProtocol) => {
          if (systemPrompt) {
            messages[0] = { role: "system", content: systemPromptFor(toolProtocol) };
          }
          return runTurn(messages, abortController.signal, {
            toolProtocol,
            host,
            sessionId: params.sessionId,
            cwd: session.cwd,
            environment: session.environment,
            background,
            tools,
            requestPermission,
            authorize,
            contextWindow,
            emit,
            novaClient,
            model,
          });
        },
      });
      turnMessages = result.turnMessages;
      completedNormally = result.stopReason !== "cancelled";
      const status = result.stopReason === "cancelled" ? "killed" : "completed";
      const current = this.backgroundJobs.get(jobId);
      if (!current || current.status !== "running") return;
      const summary = this.backgroundJobs.finish(jobId, status);
      await emitBackgroundUpdate(client, status, summary);
    } finally {
      // Queue a bounded handoff note; the next foreground prompt drains it
      // into history and the session file. If the process exits first, the
      // note is lost from the session but the full transcript survives in
      // the job artifact (read_background_output).
      const title =
        this.backgroundJobs.get(jobId)?.title ?? "Background prompt";
      const finalAssistant = [...turnMessages]
        .reverse()
        .find((message) => message.role === "assistant");
      const finalText = finalAssistant
        ? stripReasoningTags(
            stripToolCallMarkup(chatContentToText(finalAssistant.content)),
          ).trim()
        : "";
      session.pendingBackgroundHandoffs.push({
        role: "user",
        content: truncateToolOutput(
          `[Background agent job "${title}" ${completedNormally ? "completed" : "did not complete"} (jobId: ${jobId})]\n` +
            (finalText ||
              `(no final output; read_background_output with jobId ${jobId} has the full transcript)`),
          "Background job handoff",
        ),
      });
    }
  }
}
