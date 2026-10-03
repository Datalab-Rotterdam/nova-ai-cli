import type { ClipboardImage } from "./clipboard-image.js";

export type PromptImageAttachment = ClipboardImage & {
  marker: string;
};

/** Keeps binary clipboard data out of the editor while exposing stable markers. */
export class DraftImageAttachments {
  private nextImageNumber = 1;
  private readonly images = new Map<string, PromptImageAttachment>();

  add(image: ClipboardImage): PromptImageAttachment {
    const marker = `[#Image${this.nextImageNumber++}]`;
    const attachment = { ...image, marker };
    this.images.set(marker, attachment);
    return attachment;
  }

  referencedBy(text: string): PromptImageAttachment[] {
    return [...this.images.values()].filter((image) =>
      text.includes(image.marker),
    );
  }

  clear(): void {
    this.images.clear();
  }
}
