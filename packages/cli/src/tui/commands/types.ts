import type {
  BackgroundJobKind,
  BackgroundJobSummary,
  OutputResponse,
} from "@datalabrotterdam/nova-ai-agent/core/background.js";
import type { ContextCompactionResult } from "@datalabrotterdam/nova-ai-agent/core/context-compaction.js";

/** What /compact reports; the summarized history itself stays in the agent. */
export type CompactionSummary = Pick<
  ContextCompactionResult,
  "compacted" | "removedMessages" | "keptMessages"
>;
import type { InteractionMode, PermissionMode } from "../state/types.js";
import type { SessionCheckpoint } from "@datalabrotterdam/nova-ai-agent/core/sessions.js";

export type SlashCommandContext = {
  print(text: string): void;
  clear(): void;
  newSession(): Promise<void>;
  exit(): void;
  /** Exits to install the newer version and restart; returns a message when it can't. */
  requestUpdate(): string | null;
  resumeSession(sessionId?: string): boolean;
  openSessionSwitcher(): void;
  openModelPicker(): void;
  getModel(): string;
  setModel(model: string): void;
  getInteractionMode(): InteractionMode;
  setInteractionMode(mode: InteractionMode): void;
  getPermissionMode(): PermissionMode;
  setPermissionMode(mode: PermissionMode): void;
  openPermissionPicker(): void;
  /** Trusts the workspace (its MCP servers and allow rules); returns a message. */
  trustWorkspace(): string;
  openToolInspector(): void;
  openMcpInspector(): void;
  openSkillInspector(): void;
  /** Switches a skill on or off (this project, or everywhere); returns a message. */
  switchSkill(name: string, enabled: boolean, global: boolean): string;
  openUsageInspector(): void | Promise<void>;
  steerMessage(message: string): boolean;
  queuedMessages(): string[];
  clearQueuedMessages(): number;
  compactContext(): Promise<CompactionSummary>;
  rewind(turns?: number): Promise<{
    removedCheckpoints: SessionCheckpoint[];
    remainingCheckpoints: SessionCheckpoint[];
  }>;
  listModels(): Promise<Array<{ id: string; name?: string | null }>>;
  startBackgroundShell(command: string): Promise<BackgroundJobSummary>;
  startBackgroundAgent(prompt: string): Promise<BackgroundJobSummary>;
  listBackgroundJobs(kind?: BackgroundJobKind): Promise<BackgroundJobSummary[]>;
  backgroundOutput(jobId: string): Promise<OutputResponse>;
  killBackgroundJob(jobId: string): Promise<BackgroundJobSummary>;
  releaseBackgroundJob(jobId: string): Promise<BackgroundJobSummary>;
};

export type SlashCommand = {
  name: string;
  description: string;
  run(ctx: SlashCommandContext, args: string): void | Promise<void>;
};
