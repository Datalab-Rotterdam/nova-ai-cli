import { listStoredSessions, type StoredSession } from "../../acp/sessions.js";

export function listSessionsForCwd(cwd: string): StoredSession[] {
  return listStoredSessions(cwd);
}
