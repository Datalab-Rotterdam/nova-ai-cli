const COMPLETE_THINK_TAG = /^<\/?think\b[^>]*>/i;
const CLOSING_THINK_TAG = /<\/think\s*>/i;

/**
 * Removes model-internal <think> blocks and stray think tags from text that is
 * safe to inspect as a complete assistant response.
 */
export function stripReasoningTags(text: string): string {
  let result = text.replace(/<think\s*\/\s*>/gi, "");
  result = result.replace(/<think\b[^>]*>[\s\S]*?<\/think\s*>/gi, "");
  // An unterminated opening tag means the rest of the response is still
  // private reasoning. Do not expose it merely because the model omitted the
  // closing tag.
  result = result.replace(/<think\b[^>]*>[\s\S]*$/gi, "");
  return result.replace(/<\/think\s*>/gi, "");
}

/**
 * Incremental counterpart to stripReasoningTags(). It holds possible partial
 * tags across chunks and never emits content while inside a think block.
 */
export class ReasoningTagFilter {
  private pending = "";
  private insideThink = false;

  push(text: string): string {
    this.pending += text;
    let visible = "";

    while (this.pending) {
      if (this.insideThink) {
        const closing = CLOSING_THINK_TAG.exec(this.pending);
        if (closing?.index !== undefined) {
          this.pending = this.pending.slice(closing.index + closing[0].length);
          this.insideThink = false;
          continue;
        }

        const possibleClosingStart = this.pending.lastIndexOf("<");
        if (
          possibleClosingStart >= 0 &&
          isPossibleThinkTagPrefix(
            this.pending.slice(possibleClosingStart),
            true,
          )
        ) {
          this.pending = this.pending.slice(possibleClosingStart);
        } else {
          this.pending = "";
        }
        break;
      }

      const tagStart = this.pending.indexOf("<");
      if (tagStart < 0) {
        visible += this.pending;
        this.pending = "";
        break;
      }
      if (tagStart > 0) {
        visible += this.pending.slice(0, tagStart);
        this.pending = this.pending.slice(tagStart);
      }

      const tag = COMPLETE_THINK_TAG.exec(this.pending)?.[0];
      if (tag) {
        this.pending = this.pending.slice(tag.length);
        const closing = tag.startsWith("</");
        const selfClosing = /\/\s*>$/.test(tag);
        if (!closing && !selfClosing) this.insideThink = true;
        continue;
      }

      if (isPossibleThinkTagPrefix(this.pending, false)) break;

      visible += "<";
      this.pending = this.pending.slice(1);
    }

    return visible;
  }

  finish(): string {
    if (this.insideThink) {
      this.pending = "";
      return "";
    }
    const visible = isPossibleThinkTagPrefix(this.pending, false)
      ? ""
      : stripReasoningTags(this.pending);
    this.pending = "";
    return visible;
  }
}

function isPossibleThinkTagPrefix(
  value: string,
  closingOnly: boolean,
): boolean {
  const normalized = value.toLowerCase();
  const starts = closingOnly ? ["</think"] : ["<think", "</think"];
  return (
    starts.some((candidate) => candidate.startsWith(normalized)) ||
    (closingOnly
      ? /^<\/think\b[^>]*$/i.test(value)
      : /^<\/?think\b[^>]*$/i.test(value))
  );
}
