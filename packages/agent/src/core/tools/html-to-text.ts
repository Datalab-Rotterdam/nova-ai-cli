// Ported from nova-ai-vscode (src/agent/tools/htmlToText.ts); keep the logic in sync.
/**
 * Converts an HTML page to compact, markdown-like text for a language model:
 * keeps headings, paragraphs, list items, links and code, drops scripts, styles,
 * navigation chrome and markup. Dependency-free and tolerant of broken HTML.
 */
export function htmlToText(html: string, baseUrl?: string): { title?: string; text: string } {
  const title = decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '').trim() || undefined;

  let body = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg|template|iframe|canvas|form|select|button)\b[\s\S]*?<\/\1>/gi, '');

  // Prefer the main content when the page marks it.
  const main = /<(main|article)\b[^>]*>([\s\S]*?)<\/\1>/i.exec(body);
  if (main && main[2].length > 500) {
    body = main[2];
  } else {
    body = body.replace(/<(nav|header|footer|aside)\b[\s\S]*?<\/\1>/gi, '');
  }

  const text = body
    .replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_match, code: string) => `\n\n\`\`\`\n${stripTags(code)}\n\`\`\`\n\n`)
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_match, code: string) => `\`${stripTags(code)}\``)
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_match, level: string, content: string) =>
      `\n\n${'#'.repeat(Number(level))} ${stripTags(content).trim()}\n\n`)
    .replace(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_match, href: string, content: string) => {
      const label = stripTags(content).trim();
      const url = resolveUrl(decodeEntities(href), baseUrl);
      return label && url && !url.startsWith('javascript:') && !url.startsWith('#') ? `[${label}](${url})` : label;
    })
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<(br|hr)\b[^>]*>/gi, '\n')
    .replace(/<\/(p|div|section|ul|ol|table|tr|blockquote|dl|dd|dt|figure)>/gi, '\n\n')
    .replace(/<\/t[dh]>/gi, ' | ');

  return { title, text: collapseWhitespace(decodeEntities(stripTags(text))) };
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, '');
}

function resolveUrl(href: string, baseUrl?: string): string | undefined {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return undefined;
  }
}

function collapseWhitespace(value: string): string {
  return value
    .split('\n')
    .map((line) => line.replace(/[ \t\f\v ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', hellip: '…',
  mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', euro: '€', trade: '™'
};

export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === '#') {
      const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}
