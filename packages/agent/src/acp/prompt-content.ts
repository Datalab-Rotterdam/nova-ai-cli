import { fileURLToPath } from "node:url";
import type * as acp from "@agentclientprotocol/sdk";

/**
 * Where an attachment comes from: a file path for file URIs (other URIs as
 * they are) and the line range of a `#L10-L20` or `#L10` fragment, which is
 * how editors send a selection.
 */
export function describeResourceUri(uri: string): { source: string; lines: string | null } {
  const hashAt = uri.indexOf("#");
  const base = hashAt >= 0 ? uri.slice(0, hashAt) : uri;
  const range = /^L(\d+)(?:-L?(\d+))?$/.exec(hashAt >= 0 ? uri.slice(hashAt + 1) : "");
  const lines = range ? (range[2] && range[2] !== range[1] ? `${range[1]}-${range[2]}` : range[1]!) : null;
  let source = range ? base : uri;
  if (source.startsWith("file:")) {
    try {
      source = fileURLToPath(source);
    } catch {
      // not a local file URI: keep it as sent
    }
  }
  return { source, lines };
}

/** An embedded file (or selection) with its origin, so the model can cite and edit it. */
function embeddedResourceText(resource: { uri: string; text: string }): string {
  const { source, lines } = describeResourceUri(resource.uri);
  const attributes = `path="${escapeAttribute(source)}"${lines ? ` lines="${lines}"` : ""}`;
  return `<attached_file ${attributes}>\n${resource.text}\n</attached_file>`;
}

/** A file the client only links: the model reads it itself when needed. */
function resourceLinkText(link: { uri: string }): string {
  const { source, lines } = describeResourceUri(link.uri);
  return `[Attached file, not included: ${source}${lines ? `, lines ${lines}` : ""}]`;
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

export function contentBlocksToText(
  prompt: acp.PromptRequest["prompt"],
): string {
  return prompt
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "resource_link") return resourceLinkText(block);
      if (block.type === "resource" && "text" in block.resource)
        return embeddedResourceText(block.resource);
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * Wraps a steered prompt so the model treats it as guidance for the turn
 * already in progress rather than an unrelated new request — without this,
 * a raw user-role message dropped mid-loop reads like a fresh top-level ask.
 */
export function frameSteeringPrompt(
  prompt: acp.ContentBlock[],
): acp.ContentBlock[] {
  return [
    {
      type: "text",
      text: "The user sent this message while you were still working on the current task:\n\n<steering_message>",
    },
    ...prompt,
    {
      type: "text",
      text: "</steering_message>\n\nThis is guidance for the task already in progress, not a new unrelated request. Incorporate it and continue.",
    },
  ];
}

export function contentBlocksToNovaContent(
  prompt: acp.PromptRequest["prompt"],
): unknown {
  if (!prompt.some((block) => block.type === "image")) {
    return contentBlocksToText(prompt);
  }

  const content: Array<Record<string, unknown>> = [];
  for (const block of prompt) {
    if (block.type === "text") {
      content.push({ type: "text", text: block.text });
      continue;
    }
    if (block.type === "image") {
      content.push({
        type: "image_url",
        image_url: {
          url: `data:${block.mimeType};base64,${block.data}`,
        },
      });
      continue;
    }
    if (block.type === "resource_link") {
      content.push({ type: "text", text: resourceLinkText(block) });
      continue;
    }
    if (block.type === "resource" && "text" in block.resource) {
      content.push({ type: "text", text: embeddedResourceText(block.resource) });
    }
  }
  return content;
}

export function getPromptMode(params: acp.PromptRequest): string | null {
  const mode = params._meta?.["nova-ai-cli/tui-mode"];
  return typeof mode === "string" ? mode : null;
}

export function getPromptModel(params: acp.PromptRequest): string | null {
  const model = params._meta?.["nova-ai-cli/model"];
  return typeof model === "string" && model ? model : null;
}
