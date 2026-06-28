import type { BackgroundJobKind, BackgroundJobSummary, OutputResponse } from "../../acp/background.js";
import type { InteractionMode, PermissionMode } from "../state/types.js";

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
  run(ctx: SlashCommandContext, args: string): void;
};
