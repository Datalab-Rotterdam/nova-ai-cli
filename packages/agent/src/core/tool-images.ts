import type { ChatMessage } from "@datalabrotterdam/nova-sdk";
import type { BatchEntry } from "./tool-batch.js";

/**
 * Images a tool returned (an MCP server's screenshot, say) reach the model as a user message
 * right after the round's results: tool messages and the text protocol's results hold text only.
 * Only the newest round's images are sent; earlier ones become a short note, since images are
 * large and the model has seen them.
 */

// The same words as Nova AI Desktop's chat, which sends tool images the same way.
const LEAD = "The images the tools returned, in order:";
const LEFT_OUT = "[Images an earlier tool returned were left out to save room.]";

/** The message with a round's images, or null when it returned none. */
export function toolImageMessage(entries: BatchEntry[], imageInput: boolean): ChatMessage | null {
  const images = entries.flatMap((entry) =>
    (entry.images ?? []).map((image) => ({ ...image, tool: entry.name })),
  );
  if (!images.length) return null;
  if (!imageInput) {
    return {
      role: "user",
      content: `The tools returned ${images.length} image(s), but this model cannot see images. Work from the text results.`,
    };
  }
  return {
    role: "user",
    content: [
      { type: "text", text: LEAD },
      ...images.map((image) => ({
        type: "image_url" as const,
        image_url: { url: `data:${image.mimeType};base64,${image.data}` },
      })),
    ],
  } as ChatMessage;
}

/** Replaces the images of earlier rounds in `messages` (in place) with a note. */
export function dropEarlierToolImages(messages: ChatMessage[]): void {
  messages.forEach((message, index) => {
    const content = (message as { content?: unknown }).content;
    if (
      message.role === "user" &&
      Array.isArray(content) &&
      (content[0] as { text?: unknown } | undefined)?.text === LEAD
    ) {
      messages[index] = { role: "user", content: LEFT_OUT };
    }
  });
}

/** Adds a round's images after its results, leaving out those of earlier rounds. */
export function pushToolImages(
  messages: ChatMessage[],
  entries: BatchEntry[],
  imageInput: boolean,
  push: (message: ChatMessage) => void,
): void {
  const message = toolImageMessage(entries, imageInput);
  if (!message) return;
  dropEarlierToolImages(messages);
  push(message);
}
