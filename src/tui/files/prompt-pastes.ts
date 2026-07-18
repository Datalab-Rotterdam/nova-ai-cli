const LARGE_PASTE_LINE_THRESHOLD = 10;
const LARGE_PASTE_CHARACTER_THRESHOLD = 1_000;

export type PromptPasteAttachment = {
  marker: string;
  text: string;
  lineCount: number;
  characterCount: number;
};

/** Normalize terminal clipboard input before deciding whether to collapse it. */
export function normalizeClipboardPaste(value: string): string {
  const decoded = value.replace(/\u001b\[(\d+);5u/g, (match, code: string) => {
    const point = Number(code);
    if (point >= 97 && point <= 122) return String.fromCharCode(point - 96);
    if (point >= 65 && point <= 90) return String.fromCharCode(point - 64);
    return match;
  });

  return decoded
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\t/g, "    ")
    .split("")
    .filter((character) => character === "\n" || character.charCodeAt(0) >= 32)
    .join("");
}

export function isLargeClipboardPaste(text: string): boolean {
  return (
    text.split("\n").length > LARGE_PASTE_LINE_THRESHOLD ||
    text.length > LARGE_PASTE_CHARACTER_THRESHOLD
  );
}

/** Keeps a large clipboard paste out of the editor while exposing a stable marker. */
export class DraftPasteAttachments {
  private nextPasteNumber = 1;
  private readonly pastes = new Map<string, PromptPasteAttachment>();

  add(text: string): PromptPasteAttachment {
    const lineCount = text.split("\n").length;
    const characterCount = text.length;
    const count =
      lineCount > LARGE_PASTE_LINE_THRESHOLD
        ? `${lineCount} lines`
        : `${characterCount} characters`;
    const marker = `[Pasted from clipboard #${this.nextPasteNumber++}: ${count}]`;
    const attachment = { marker, text, lineCount, characterCount };
    this.pastes.set(marker, attachment);
    return attachment;
  }

  referencedBy(text: string): PromptPasteAttachment[] {
    return [...this.pastes.values()].filter((paste) =>
      text.includes(paste.marker),
    );
  }

  clear(): void {
    this.pastes.clear();
  }
}

export function expandPromptPastes(
  text: string,
  pastes: PromptPasteAttachment[],
): string {
  if (pastes.length === 0) return text;
  const byMarker = new Map(pastes.map((paste) => [paste.marker, paste.text]));
  const markers = [...byMarker.keys()]
    .sort((left, right) => right.length - left.length)
    .map((marker) => marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return text.replace(
    new RegExp(markers.join("|"), "g"),
    (marker) => byMarker.get(marker) ?? marker,
  );
}
