import type { ContextUsage } from "@datalabrotterdam/nova-ai-agent/core/context-usage.js";
import type { InteractionMode } from "@datalabrotterdam/nova-ai-agent/core/interaction-modes.js";
import type {
  UserInputRequest,
  UserInputResponse,
} from "@datalabrotterdam/nova-ai-agent/core/user-questions.js";

export type ToolDiffView = {
  path: string;
  oldText: string | null;
  newText: string;
};

export type ToolCallView = {
  toolCallId: string;
  name: string;
  mutating: boolean;
  kind: string;
  args: Record<string, unknown>;
  status: "pending" | "completed" | "failed";
  output: string | null;
  diff: ToolDiffView | null;
};

export type BackgroundJobView = {
  jobId: string;
  kind: "terminal" | "prompt";
  title: string;
  status: "running" | "completed" | "failed" | "killed" | "released";
  outputPath?: string;
  preview: string;
};

export type PlanEntryView = {
  content: string;
  priority: "high" | "medium" | "low";
  status: "pending" | "in_progress" | "completed";
};

export type UIMessage =
  | {
      id: string;
      role: "user";
      text: string;
      queued?: "steer" | "followup";
    }
  | { id: string; role: "assistant"; text: string; streaming: boolean }
  | { id: string; role: "error"; text: string }
  | { id: string; role: "tool"; call: ToolCallView }
  | { id: string; role: "background"; job: BackgroundJobView };

export type PermissionScope = "once" | "session" | "always";

export type PermissionRequestView = {
  toolCallId: string;
  toolName: string;
  /** The agent's human-readable description, e.g. "Run `npm test`". */
  title?: string;
  kind: string;
  args: Record<string, unknown>;
  resolve(allow: boolean, scope: PermissionScope): void;
};

export type QuestionRequestView = {
  id: string;
  request: UserInputRequest;
  resolve(response: UserInputResponse): void;
};

export type SessionMeta = {
  sessionId: string;
  cwd: string;
  title: string | null;
  updatedAt: string;
};

export type UpdateAvailable = {
  currentVersion: string;
  latestVersion: string;
  /** The npm dist-tag that has latestVersion (latest, alpha, …). */
  tag: string;
  command: string;
  /** This is a global npm install that nova-ai can update itself (/update). */
  installable?: boolean;
};

export type Mode =
  | "chat"
  | "session-switcher"
  | "model-picker"
  | "permission-picker"
  | "background-tasks";

export type PermissionMode = "ask" | "acceptEdits" | "bypassAll";
export type { InteractionMode } from "@datalabrotterdam/nova-ai-agent/core/interaction-modes.js";

export type UIState = {
  messages: UIMessage[];
  plan: PlanEntryView[];
  pendingPermission: PermissionRequestView | null;
  pendingQuestion: QuestionRequestView | null;
  inputHistory: string[];
  busy: boolean;
  mode: Mode;
  permissionMode: PermissionMode;
  interactionMode: InteractionMode;
  sessionId: string;
  cwd: string;
  statusLine: string | null;
  queuedCount: number;
  contextUsage: ContextUsage | null;
  updateAvailable: UpdateAvailable | null;
};
