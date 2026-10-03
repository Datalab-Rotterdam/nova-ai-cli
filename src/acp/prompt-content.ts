import type * as acp from "@agentclientprotocol/sdk";

export function contentBlocksToText(
  prompt: acp.PromptRequest["prompt"],
): string {
  return prompt
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "resource_link") return block.uri;
      if (block.type === "resource" && "text" in block.resource)
        return block.resource.text;
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
      content.push({ type: "text", text: block.uri });
      continue;
    }
    if (block.type === "resource" && "text" in block.resource) {
      content.push({ type: "text", text: block.resource.text });
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
