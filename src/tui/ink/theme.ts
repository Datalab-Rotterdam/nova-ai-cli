import chalk from "chalk";

/** Hex values for Ink's `color`/`backgroundColor` props. */
export const palette = {
  primary: "#7dd3fc",
  accent: "#c4b5fd",
  success: "#86efac",
  warning: "#fbbf24",
  danger: "#f87171",
  muted: "#94a3b8",
  faint: "#64748b",
  code: "#fcd34d",
  diffAddBg: "#1b3a24",
  diffRemoveBg: "#3d1f1f",
} as const;

/** The same colors as ANSI string helpers, for text built outside JSX. */
export const colors = {
  primary: chalk.hex(palette.primary),
  accent: chalk.hex(palette.accent),
  success: chalk.hex(palette.success),
  warning: chalk.hex(palette.warning),
  danger: chalk.hex(palette.danger),
  muted: chalk.hex(palette.muted),
  faint: chalk.hex(palette.faint),
  code: chalk.hex(palette.code),
};

export const ASSISTANT_MARKER = String.fromCodePoint(0x2726);
export const WORKING_FRAMES = [ASSISTANT_MARKER, "✧", "·", "✧"] as const;
