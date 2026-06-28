export type ToolCallView = {
  toolCallId: string;
  name: string;
  mutating: boolean;
  args: Record<string, unknown>;
  status: "pending" | "completed" | "failed";
  output: string | null;
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
  | { id: string; role: "user"; text: string }
  | { id: string; role: "assistant"; text: string; streaming: boolean }
  | { id: string; role: "error"; text: string }
  | { id: string; role: "tool"; call: ToolCallView }
  | { id: string; role: "background"; job: BackgroundJobView };

export type PermissionScope = "once" | "session" | "always";

export type PermissionRequestView = {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  resolve(allow: boolean, scope: PermissionScope): void;
};

export type SessionMeta = {
  sessionId: string;
  cwd: string;
  title: string | null;
  updatedAt: string;
};

export type Mode = "chat" | "session-switcher" | "model-picker" | "permission-picker";

export type PermissionMode = "ask" | "acceptEdits" | "bypassAll";
export type InteractionMode = "agent" | "ask" | "plan";

export type UIState = {
  messages: UIMessage[];
  pendingPermission: PermissionRequestView | null;
  inputHistory: string[];
  busy: boolean;
  mode: Mode;
  permissionMode: PermissionMode;
  interactionMode: InteractionMode;
  sessionId: string;
  cwd: string;
  statusLine: string | null;
  queuedCount: number;
};
