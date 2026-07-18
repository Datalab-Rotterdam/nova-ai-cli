import type { ContextUsage } from "../../core/context-usage.js";
import type { InteractionMode } from "../../core/interaction-modes.js";
import type {
  UserInputRequest,
  UserInputResponse,
} from "../../core/user-questions.js";

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
  command: string;
};

export type Mode =
  | "chat"
  | "session-switcher"
  | "model-picker"
  | "permission-picker"
  | "background-tasks";

export type PermissionMode = "ask" | "acceptEdits" | "bypassAll";
export type { InteractionMode } from "../../core/interaction-modes.js";

export type UIState = {
  messages: UIMessage[];
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
