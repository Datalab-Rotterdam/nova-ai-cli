/** Extract readable text without serializing embedded base64 image payloads. */
export function chatContentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return safeScalar(content);

  const text: string[] = [];
  let images = 0;
  for (const part of content) {
    if (typeof part === "string") {
      text.push(part);
      continue;
    }
    if (!part || typeof part !== "object") continue;
    const item = part as Record<string, unknown>;
    if (item.type === "text" && typeof item.text === "string") {
      text.push(item.text);
    } else if (
      item.type === "image_url" ||
      item.type === "input_image" ||
      item.type === "image"
    ) {
      images++;
    } else if (typeof item.content === "string") {
      text.push(item.content);
    }
  }

  const joined = text.filter(Boolean).join("\n");
  if (!images || /\[#Image\d+\]/.test(joined)) return joined;
  return [joined, ...Array.from({ length: images }, () => "[image]")]
    .filter(Boolean)
    .join("\n");
}

function safeScalar(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}
