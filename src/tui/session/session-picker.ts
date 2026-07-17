import { listStoredSessions, type StoredSession } from "../../acp/sessions.js";

export type SessionPickerItem = {
  value: string;
  label: string;
  description: string;
  columns: {
    leading: string;
    main: string;
    trailing: string;
  };
};

export function listSessionsForCwd(cwd: string): StoredSession[] {
  return listStoredSessions(cwd);
}

export function listSessionPickerItems(
  cwd: string,
  now = Date.now(),
): SessionPickerItem[] {
  return listSessionsForCwd(cwd).map((session) =>
    toSessionPickerItem(session, now),
  );
}

export function toSessionPickerItem(
  session: StoredSession,
  now = Date.now(),
): SessionPickerItem {
  const age = formatTimeAgo(session.updatedAt, now);
  const title = oneLineTitle(session.title);
  return {
    value: session.sessionId,
    label: age,
    description: title,
    columns: {
      leading: age,
      main: title,
      trailing: formatDateTime(session.updatedAt),
    },
  };
}

export function formatTimeAgo(updatedAt: string, now = Date.now()): string {
  const timestamp = Date.parse(updatedAt);
  if (!Number.isFinite(timestamp)) return "unknown";
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1_000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (days < 60) return `${weeks}w ago`;
  const months = Math.floor(days / 30);
  if (days < 730) return `${months}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

export function oneLineTitle(title: string | null): string {
  return title?.replace(/\s+/g, " ").trim() || "(untitled)";
}

export function formatDateTime(updatedAt: string): string {
  const timestamp = Date.parse(updatedAt);
  return Number.isFinite(timestamp)
    ? new Date(timestamp).toISOString()
    : "unknown";
}
