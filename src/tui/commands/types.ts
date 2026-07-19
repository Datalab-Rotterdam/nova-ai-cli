import type {
  BackgroundJobKind,
  BackgroundJobSummary,
  OutputResponse,
} from "../../acp/background.js";
import type { ContextCompactionResult } from "../../core/context-compaction.js";
import type { InteractionMode, PermissionMode } from "../state/types.js";
import type { SessionCheckpoint } from "../../acp/sessions.js";

export type SlashCommandContext = {
  print(text: string): void;
  clear(): void;
  newSession(): Promise<void>;
  exit(): void;
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
  openToolInspector(): void;
  openMcpInspector(): void;
  openSkillInspector(): void;
  openUsageInspector(): void | Promise<void>;
  steerMessage(message: string): boolean;
  queuedMessages(): string[];
  clearQueuedMessages(): number;
  compactContext(): Promise<ContextCompactionResult>;
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
