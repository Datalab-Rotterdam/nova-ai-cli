import type { ChatMessage } from "@datalabrotterdam/nova-sdk";
import type { InteractionMode } from "../interaction-modes.js";
import type { PermissionPolicy } from "../policy/policy.js";
import type { McpConnection, McpConnectionFailure } from "../mcp.js";
import type { MemorySnapshot } from "../memory.js";
import type { PromptQueue } from "../prompt-queue.js";
import type { SkillDefinition } from "../skills.js";
import type { ToolEnvironment } from "../tools/environment.js";
import type { ToolDefinition } from "../tools/types.js";

/** In-memory state of one agent session, shared by every front end. */
export type Session = {
  /** The turn currently running, for operations that must not overlap it. */
  pendingPrompt: AbortController | null;
  /** Every turn that is running or waiting to run; aborted on cancel. */
  activeTurns: Set<AbortController>;
  /** Settles when the last enqueued turn is done; turns run one at a time. */
  turnQueue: Promise<void>;
  promptQueue: PromptQueue;
  cwd: string;
  history: ChatMessage[];
  /**
   * Finished background prompt jobs park a bounded handoff note here; the
   * next foreground prompt drains it into history. Background jobs never
   * write to session.history directly — a job finishing mid-turn would
   * otherwise interleave messages the foreground model never saw.
   */
  pendingBackgroundHandoffs: ChatMessage[];
  title: string | null;
  mcpConnections: McpConnection[];
  mcpTools: ToolDefinition[];
  mcpFailures: McpConnectionFailure[];
  environment: ToolEnvironment;
  skills: SkillDefinition[];
  memory: MemorySnapshot;
  mode: InteractionMode;
  /** Permission rules, mode and approvals of this session. */
  policy: PermissionPolicy;
  model: string | null;
};
