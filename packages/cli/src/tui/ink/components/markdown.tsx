import chalk from "chalk";
import { Box, Text } from "ink";
import { marked, type Token, type Tokens } from "marked";
import stringWidth from "string-width";
import type { ReactNode } from "react";
import { highlightLines, supportedLanguage } from "../highlight.js";
import { colors, palette } from "../theme.js";

/** Renders Markdown with Ink boxes so wrapping and indentation follow the terminal width. */
export function Markdown({ text }: { text: string }): ReactNode {
  const tokens = marked.lexer(text, { gfm: true });
  return <Blocks tokens={tokens} />;
}

function Blocks({ tokens, tight = false }: { tokens: Token[]; tight?: boolean }) {
  const blocks = tokens.filter((token) => token.type !== "space");
  return (
    <Box flexDirection="column">
      {blocks.map((token, index) => (
        <Box key={index} marginTop={index > 0 && !tight ? 1 : 0}>
          <Block token={token} />
        </Box>
      ))}
    </Box>
  );
}

function Block({ token }: { token: Token }): ReactNode {
  switch (token.type) {
    case "heading": {
      const heading = token as Tokens.Heading;
      return (
        <Text bold color={palette.primary}>
          {inline(heading.tokens)}
        </Text>
      );
    }
    case "paragraph":
      return <Text>{inline((token as Tokens.Paragraph).tokens)}</Text>;
    case "text": {
      const text = token as Tokens.Text;
      return <Text>{text.tokens ? inline(text.tokens) : text.text}</Text>;
    }
    case "code":
      return <CodeBlock code={token as Tokens.Code} />;
    case "list":
      return <List list={token as Tokens.List} />;
    case "blockquote":
      return (
        <Box
          borderStyle="bold"
          borderColor={palette.accent}
          borderTop={false}
          borderRight={false}
          borderBottom={false}
          paddingLeft={1}
        >
          <Box flexDirection="column" flexGrow={1} flexShrink={1}>
            <Blocks tokens={(token as Tokens.Blockquote).tokens} />
          </Box>
        </Box>
      );
    case "hr":
      return (
        <Box
          flexGrow={1}
          borderStyle="single"
          borderColor={palette.faint}
          borderTop
          borderRight={false}
          borderBottom={false}
          borderLeft={false}
        />
      );
    case "table":
      return <Table table={token as Tokens.Table} />;
    case "html":
      return <Text>{(token as Tokens.HTML).text.trimEnd()}</Text>;
    default:
      return "raw" in token ? <Text>{String(token.raw).trimEnd()}</Text> : null;
  }
}

function CodeBlock({ code }: { code: Tokens.Code }) {
  const language = supportedLanguage(code.lang);
  const lines = highlightLines(code.text, language);
  return (
    <Box flexDirection="column" paddingLeft={2}>
      {lines.map((line, index) => (
        <Text key={index}>{language ? line : chalk.white(line)}</Text>
      ))}
    </Box>
  );
}

function List({ list }: { list: Tokens.List }) {
  const start = typeof list.start === "number" ? list.start : 1;
  return (
    <Box flexDirection="column">
      {list.items.map((item, index) => {
        const bullet = list.ordered ? `${start + index}.` : "•";
        const checkbox = item.task ? (item.checked ? "[x] " : "[ ] ") : "";
        const content = item.tokens.filter((token) => token.type !== "checkbox");
        return (
          <Box key={index} marginTop={index > 0 && list.loose ? 1 : 0}>
            <Box flexShrink={0}>
              <Text color={palette.accent}>{`${bullet} `}</Text>
            </Box>
            <Box flexDirection="column" flexGrow={1} flexShrink={1}>
              {checkbox ? (
                <Box>
                  <Box flexShrink={0}>
                    <Text color={item.checked ? palette.success : palette.faint}>
                      {checkbox}
                    </Text>
                  </Box>
                  <Box flexGrow={1} flexShrink={1}>
                    <Blocks tokens={content} tight={!list.loose} />
                  </Box>
                </Box>
              ) : (
                <Blocks tokens={content} tight={!list.loose} />
              )}
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}

function Table({ table }: { table: Tokens.Table }) {
  const header = table.header.map((cell) => chalk.bold(inline(cell.tokens)));
  const rows = table.rows.map((row) => row.map((cell) => inline(cell.tokens)));
  const widths = header.map((cell, column) =>
    Math.max(
      stringWidth(cell),
      ...rows.map((row) => stringWidth(row[column] ?? "")),
    ),
  );
  const pad = (value: string, column: number) => {
    const space = Math.max(0, widths[column]! - stringWidth(value));
    const align = table.align[column];
    if (align === "right") return " ".repeat(space) + value;
    if (align === "center") {
      const left = Math.floor(space / 2);
      return " ".repeat(left) + value + " ".repeat(space - left);
    }
    return value + " ".repeat(space);
  };
  const line = (cells: string[]) =>
    cells.map((cell, column) => pad(cell, column)).join(colors.faint(" │ "));
  const separator = colors.faint(
    widths.map((width) => "─".repeat(width)).join("─┼─"),
  );
  return (
    <Box flexDirection="column">
      <Text>{line(header)}</Text>
      <Text>{separator}</Text>
      {rows.map((row, index) => (
        <Text key={index}>{line(row)}</Text>
      ))}
    </Box>
  );
}

/** Inline tokens as one ANSI string; Ink wraps it. */
export function inline(tokens: Token[] | undefined): string {
  if (!tokens) return "";
  return tokens
    .map((token): string => {
      switch (token.type) {
        case "strong":
          return chalk.bold(inline((token as Tokens.Strong).tokens));
        case "em":
          return chalk.italic(inline((token as Tokens.Em).tokens));
        case "del":
          return chalk.strikethrough(inline((token as Tokens.Del).tokens));
        case "codespan":
          return colors.code((token as Tokens.Codespan).text);
        case "br":
          return "\n";
        case "link": {
          const link = token as Tokens.Link;
          const label = inline(link.tokens);
          const plain = link.text.replace(/^mailto:/, "");
          return plain === link.href || label === link.href
            ? colors.primary(chalk.underline(link.href))
            : `${colors.primary(chalk.underline(label))} ${colors.faint(`(${link.href})`)}`;
        }
        case "image": {
          const image = token as Tokens.Image;
          return colors.faint(`[image: ${image.text || image.href}]`);
        }
        case "text": {
          const text = token as Tokens.Text;
          return text.tokens ? inline(text.tokens) : text.text;
        }
        case "escape":
          return (token as Tokens.Escape).text;
        case "html":
          return (token as Tokens.HTML).text;
        default:
          return "text" in token ? String(token.text) : String(token.raw ?? "");
      }
    })
    .join("");
}
