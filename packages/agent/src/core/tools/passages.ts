/*
 * Passage selection, as in the VS Code extension and the Nova AI desktop app:
 * the parts of a page's text that match the query best, in page order,
 * within a character limit. A page is cut to what answers the question
 * instead of its first screen.
 */

/** Lowercase without accents, so "Café" and "cafe" compare equal. */
const fold = (value: string) =>
  value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();

const words = (value: string) => fold(value).match(/[\p{L}\p{N}]{2,}/gu) ?? [];

/**
 * Splits page text into blocks: one per paragraph, long paragraphs cut at
 * `size` characters, and runs of short paragraphs (list items, table rows)
 * joined up to `size`.
 */
function blocks(text: string, size: number): string[] {
  const result: { text: string; short: boolean }[] = [];
  for (const paragraph of text.split(/\n+/).map((item) => item.trim())) {
    if (!paragraph) continue;
    const last = result.at(-1);
    const short = paragraph.length < 160;
    if (last && last.short && short && last.text.length + paragraph.length < size) {
      last.text = `${last.text}\n${paragraph}`;
    } else if (short) {
      result.push({ text: paragraph, short: true });
    } else {
      for (let start = 0; start < paragraph.length; start += size) {
        result.push({ text: paragraph.slice(start, start + size), short: false });
      }
    }
  }
  return result.map((block) => block.text);
}

/**
 * The parts of a page that match the query best, in page order, within
 * `limit` characters. A block scores one point per distinct query word it
 * contains (also inside longer words). A page without any match is cut at
 * the start.
 */
export function selectPassages(text: string, query: string, limit: number): string {
  if (text.length <= limit) return text;
  const terms = [...new Set(words(query))];
  const parts = blocks(text, Math.min(600, limit)).map((block, index) => {
    const folded = fold(block);
    return { block, index, score: terms.filter((term) => folded.includes(term)).length };
  });
  const chosen: typeof parts = [];
  let used = 0;
  const matching = parts.filter((part) => part.score > 0);
  for (const part of matching.sort((a, b) => b.score - a.score || a.index - b.index)) {
    if (used + part.block.length > limit) continue;
    chosen.push(part);
    used += part.block.length + 3;
  }
  if (!chosen.length) return text.slice(0, limit);
  return chosen
    .sort((a, b) => a.index - b.index)
    .map((part, position, list) =>
      position > 0 && list[position - 1]!.index !== part.index - 1 ? `…\n${part.block}` : part.block,
    )
    .join("\n");
}
