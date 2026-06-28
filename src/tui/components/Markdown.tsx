import chalk from "chalk";
import { highlight } from "cli-highlight";
import { Box, Text } from "ink";
import { marked, type Tokens } from "marked";
import React from "react";
import { useTheme } from "../theme/index.js";

function renderInline(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, (_, inner) => chalk.bold(inner))
    .replace(/`([^`]+)`/g, (_, inner) => chalk.cyan(inner))
    .replace(/\*(.+?)\*/g, (_, inner) => chalk.italic(inner));
}

function highlightCode(code: string, lang: string | undefined): string {
  try {
    return highlight(code, { language: lang || undefined, ignoreIllegals: true });
  } catch {
    return code;
  }
}

export function Markdown({ text }: { text: string }): React.ReactElement {
  const theme = useTheme();
  const tokens = marked.lexer(text);

  return (
    <Box flexDirection="column">
      {tokens.map((token, i) => {
        if (token.type === "code") {
          return (
            <Box key={i} flexDirection="column" borderStyle="round" borderColor={theme.border} paddingX={1}>
              <Text>{highlightCode(token.text, token.lang)}</Text>
            </Box>
          );
        }
        if (token.type === "heading") {
          return (
            <Text key={i} bold color={theme.primary}>
              {renderInline(token.text)}
            </Text>
          );
        }
        if (token.type === "list") {
          return (
            <Box key={i} flexDirection="column">
              {token.items.map((item: Tokens.ListItem, j: number) => (
                <Text key={j}>
                  {"- "}
                  {renderInline(item.text)}
                </Text>
              ))}
            </Box>
          );
        }
        if (token.type === "space") return null;
        return <Text key={i}>{renderInline("text" in token ? (token.text as string) : token.raw)}</Text>;
      })}
    </Box>
  );
}
