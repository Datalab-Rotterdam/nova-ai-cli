/**
 * Per-session behaviour a client can set (the VS Code extension maps its
 * settings onto these). Absent values keep the agent's defaults, so a client
 * that sends nothing gets exactly the standard behaviour.
 */
export type SessionSettings = {
  /** Most model ↔ tool rounds in one turn; null: the agent's default (64). */
  maxToolRounds: number | null;
  /**
   * Summarize older messages when the context runs full (before a model call
   * past compactThreshold, and after the model rejects a request as too
   * long); false lets an overflow fail the turn.
   */
  autoCompact: boolean;
  /** Share of the context window (0.3–0.95) that triggers it; null: 0.8. */
  compactThreshold: number | null;
  /** Memory, NOVA.md and AGENTS.md in the prompt, and the memory tools. */
  memory: boolean;
  /** Time limit for commands that do not set their own; null: 120 s. */
  commandTimeoutMs: number | null;
};

export const DEFAULT_SESSION_SETTINGS: Readonly<SessionSettings> = Object.freeze({
  maxToolRounds: null,
  autoCompact: true,
  compactThreshold: null,
  memory: true,
  commandTimeoutMs: null,
});

/** Where clients put settings on session/new, load, resume and fork. */
export const SETTINGS_META_KEY = "nova-ai-cli/settings";

/**
 * Applies a client's settings object over `base`. Accepted keys:
 * maxToolRounds (1–200), autoCompact (boolean), compactThreshold (0.3–0.95),
 * memory (boolean), commandTimeoutSeconds (5–600).
 * Numbers are clamped to those ranges; anything else is ignored.
 */
export function applySessionSettings(
  base: Readonly<SessionSettings>,
  input: unknown,
): SessionSettings {
  const next: SessionSettings = { ...base };
  if (!input || typeof input !== "object" || Array.isArray(input)) return next;
  const value = input as Record<string, unknown>;
  const number = (raw: unknown) => (typeof raw === "number" && Number.isFinite(raw) ? raw : null);

  const rounds = number(value.maxToolRounds);
  if (rounds !== null) next.maxToolRounds = clamp(Math.round(rounds), 1, 200);
  if (typeof value.autoCompact === "boolean") next.autoCompact = value.autoCompact;
  const threshold = number(value.compactThreshold);
  if (threshold !== null) next.compactThreshold = clamp(threshold, 0.3, 0.95);
  if (typeof value.memory === "boolean") next.memory = value.memory;
  const seconds = number(value.commandTimeoutSeconds);
  if (seconds !== null) next.commandTimeoutMs = clamp(Math.round(seconds), 5, 600) * 1_000;
  return next;
}

/** The settings a client sent in a request's `_meta`, over the defaults. */
export function settingsFromMeta(meta: unknown): SessionSettings {
  const settings =
    meta && typeof meta === "object" ? (meta as Record<string, unknown>)[SETTINGS_META_KEY] : undefined;
  return applySessionSettings(DEFAULT_SESSION_SETTINGS, settings);
}

/** The settings as clients send them (seconds instead of milliseconds). */
export function sessionSettingsView(settings: Readonly<SessionSettings>): {
  maxToolRounds: number | null;
  autoCompact: boolean;
  compactThreshold: number | null;
  memory: boolean;
  commandTimeoutSeconds: number | null;
} {
  return {
    maxToolRounds: settings.maxToolRounds,
    autoCompact: settings.autoCompact,
    compactThreshold: settings.compactThreshold,
    memory: settings.memory,
    commandTimeoutSeconds: settings.commandTimeoutMs === null ? null : settings.commandTimeoutMs / 1_000,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
