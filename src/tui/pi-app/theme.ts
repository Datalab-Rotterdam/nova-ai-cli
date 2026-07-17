import chalk from "chalk";
import type {
  EditorTheme,
  MarkdownTheme,
  SelectListTheme,
} from "@earendil-works/pi-tui";

export const colors = {
  primary: chalk.hex("#7dd3fc"),
  accent: chalk.hex("#c4b5fd"),
  success: chalk.hex("#86efac"),
  warning: chalk.hex("#fbbf24"),
  danger: chalk.hex("#f87171"),
  muted: chalk.hex("#94a3b8"),
  faint: chalk.hex("#64748b"),
  code: chalk.hex("#fcd34d"),
};

export const selectListTheme: SelectListTheme = {
  selectedPrefix: colors.primary,
  selectedText: chalk.bold.white,
  description: colors.muted,
  scrollInfo: colors.faint,
  noMatch: colors.warning,
};

export const editorTheme: EditorTheme = {
  borderColor: colors.primary,
  selectList: selectListTheme,
};

export const markdownTheme: MarkdownTheme = {
  heading: (text) => colors.primary(chalk.bold(text)),
  link: (text) => colors.primary(chalk.underline(text)),
  linkUrl: colors.faint,
  code: colors.code,
  codeBlock: chalk.white,
  codeBlockBorder: colors.faint,
  quote: colors.muted,
  quoteBorder: colors.accent,
  hr: colors.faint,
  listBullet: colors.accent,
  bold: chalk.bold,
  italic: chalk.italic,
  strikethrough: chalk.strikethrough,
  underline: chalk.underline,
  codeBlockIndent: "  ",
};
