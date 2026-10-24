/*
 * Web search, as in the VS Code extension (and the Nova AI desktop app): a
 * keyless search over a few providers, then the top result pages are opened
 * and cut down to the passages that match the query, numbered for citation.
 * A provider that fails (captcha, outage) falls through to the next one.
 */
import { readPackageVersion } from "../version.js";
import { readLimited } from "./fetch-url.js";
import { htmlToText } from "./html-to-text.js";
import { selectPassages } from "./passages.js";
import type { ToolDefinition } from "./types.js";

export type WebResult = { title: string; url: string; snippet: string };

export type SearchProvider = {
  name: string;
  search(query: string, options: { signal?: AbortSignal; limit?: number }): Promise<WebResult[]>;
};

export type Page = { url: string; title: string; text: string };

const SEARCH_TIMEOUT_MS = 30_000;
const PAGE_TIMEOUT_MS = 15_000;
const PAGE_MAX_BYTES = 2 * 1024 * 1024;
/** How much of each opened page is offered to the model. */
const PASSAGE_LIMIT = 6_000;
const PAGES_TO_READ = 4;
const RESULT_LIMIT = 8;

const userAgent = () =>
  `nova-ai-agent/${readPackageVersion() ?? "dev"} (+https://github.com/Datalab-Rotterdam/nova-ai-cli)`;

const tagText = (value: string) =>
  value
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();

/** DuckDuckGo wraps result links in a redirect: //duckduckgo.com/l/?uddg=<url>. */
function duckDuckGoUrl(link: string): string {
  try {
    const url = new URL(link.startsWith("//") ? `https:${link}` : link);
    return url.searchParams.get("uddg") ?? url.toString();
  } catch {
    return "";
  }
}

/** Reads DuckDuckGo's HTML results page; no key or account. */
export const duckDuckGo: SearchProvider = {
  name: "DuckDuckGo",
  async search(query, { signal, limit = RESULT_LIMIT }) {
    const url = new URL("https://html.duckduckgo.com/html/");
    url.searchParams.set("q", query);
    const response = await fetch(url, { signal, headers: { "User-Agent": userAgent(), Accept: "text/html" } });
    if (!response.ok) throw new Error(`DuckDuckGo returned HTTP ${response.status}.`);
    const html = await response.text();
    if (/anomaly-modal|challenge-form/.test(html)) throw new Error("DuckDuckGo asked for a captcha.");
    return html
      .split(/<div[^>]+class="[^"]*\bresult\b[^"]*results_links/)
      .slice(1)
      .map((block) => {
        const anchor = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
        const snippet = /class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|div)>/.exec(block);
        return {
          title: tagText(anchor?.[2] ?? ""),
          url: duckDuckGoUrl(tagText(anchor?.[1] ?? "")),
          snippet: tagText(snippet?.[1] ?? ""),
        };
      })
      .filter((result) => result.title && /^https?:/.test(result.url))
      .slice(0, limit);
  },
};

type YouItem = { url?: string; title?: string; description?: string; snippets?: string[] };

/** You.com's search API for AI agents, on its free tier without a key. */
export const you: SearchProvider = {
  name: "You.com",
  async search(query, { signal, limit = RESULT_LIMIT }) {
    const url = new URL("https://api.you.com/v1/agents/search");
    url.searchParams.set("query", query);
    url.searchParams.set("count", String(limit));
    const response = await fetch(url, {
      signal,
      // The keyless endpoint can announce gzip with a body that fails to decode.
      headers: { Accept: "application/json", "Accept-Encoding": "identity", "User-Agent": userAgent() },
    });
    if (!response.ok) throw new Error(`You.com returned HTTP ${response.status}.`);
    const data = (await response.json()) as { results?: { web?: YouItem[]; news?: YouItem[] } };
    return [...(data.results?.web ?? []), ...(data.results?.news ?? [])]
      .filter((item) => item.url && item.title)
      .map((item) => ({
        title: item.title!,
        url: item.url!,
        snippet: item.snippets?.length ? item.snippets.join(" ") : (item.description ?? ""),
      }))
      .slice(0, limit);
  },
};

/** SearXNG, a metasearch engine a user or organization hosts; its JSON format must be allowed. */
export function searxng(server: string): SearchProvider {
  return {
    name: "SearXNG",
    async search(query, { signal, limit = RESULT_LIMIT }) {
      const url = new URL("search", `${server.trim().replace(/\/+$/, "")}/`);
      url.searchParams.set("q", query);
      url.searchParams.set("format", "json");
      const response = await fetch(url, { signal, headers: { Accept: "application/json", "User-Agent": userAgent() } });
      if (response.status === 403) {
        throw new Error("The SearXNG server does not allow the JSON format (search.formats in settings.yml).");
      }
      if (!response.ok) throw new Error(`SearXNG returned HTTP ${response.status}.`);
      const data = (await response.json()) as { results?: Array<{ url?: string; title?: string; content?: string }> };
      return (data.results ?? [])
        .filter((item) => item.url && item.title)
        .map((item) => ({ title: item.title!, url: item.url!, snippet: item.content ?? "" }))
        .slice(0, limit);
    },
  };
}

/** Tried in order: the session's own SearXNG server first, then You.com, then DuckDuckGo. */
export function searchProviders(searxngUrl: string | null): SearchProvider[] {
  return [...(searxngUrl ? [searxng(searxngUrl)] : []), you, duckDuckGo];
}

/** Tries each provider until one returns results; undefined when none could. */
export async function searchWeb(
  query: string,
  providers: readonly SearchProvider[],
  options: { signal?: AbortSignal; limit?: number } = {},
): Promise<{ provider: string; results: WebResult[] } | undefined> {
  for (const provider of providers) {
    if (options.signal?.aborted) return undefined;
    try {
      const results = await provider.search(query, options);
      if (results.length) return { provider: provider.name, results };
    } catch {
      // A provider that fails (captcha, down, blocked) falls through to the next.
    }
  }
  return undefined;
}

/** Opens a result page (redirects followed: the URL came from the search engine) as text. */
export async function openSearchPage(url: string, outer: AbortSignal): Promise<Page> {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only http and https pages can be opened.");
  }
  const signal = AbortSignal.any([outer, AbortSignal.timeout(PAGE_TIMEOUT_MS)]);
  const response = await fetch(parsed, {
    signal,
    redirect: "follow",
    headers: { "User-Agent": userAgent(), Accept: "text/html,text/plain;q=0.9" },
  });
  if (!response.ok) throw new Error(`The page returned HTTP ${response.status}.`);
  const contentType = response.headers.get("content-type") ?? "";
  const body = await readLimited(response, PAGE_MAX_BYTES);
  const finalUrl = response.url || parsed.toString();
  if (/html/i.test(contentType) || /^\s*<(!doctype|html)/i.test(body.slice(0, 200))) {
    const { title, text } = htmlToText(body, finalUrl);
    return { url: finalUrl, title: title || parsed.hostname, text };
  }
  if (/^(text\/|application\/(json|javascript|x-yaml|yaml))/i.test(contentType) || !contentType) {
    return { url: finalUrl, title: parsed.hostname, text: body };
  }
  throw new Error(`This page is ${contentType}, which cannot be read as text.`);
}

/**
 * Numbered sources the answer cites as [1], [2], …, with the opened pages'
 * matching passages; a page that could not be opened falls back to its snippet.
 */
export function formatSearchOutput(
  provider: string,
  query: string,
  results: readonly WebResult[],
  pages: ReadonlyMap<string, Page | undefined>,
): string {
  const lines = [`Searched the web with ${provider} for "${query}". Cite the sources below as [1], [2], … in the answer.`];
  results.forEach((result, index) => {
    const text = pages.get(result.url)?.text.trim();
    const body = text ? selectPassages(text, query, PASSAGE_LIMIT) : result.snippet || "(no snippet)";
    lines.push(`[${index + 1}] ${result.title}\n${result.url}\n${body}`);
  });
  return lines.join("\n\n");
}

/**
 * The query goes to third-party search engines and can carry data out, like
 * a fetch_url URL, so the tool is mutating: it asks unless a rule allows it.
 */
export function createWebSearchTool(
  searxngUrl: () => string | null,
  providers: (url: string | null) => readonly SearchProvider[] = searchProviders,
): ToolDefinition {
  return {
    name: "web_search",
    description:
      "search the web for current or external information: news, recent events, prices, documentation, or facts you are unsure about. It searches with keyless providers and opens the top result pages, so prefer it over fetch_url when you do not have the exact page yet. Returns numbered sources; cite them in your answer as [1], [2], ….",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "a concise search query, as you would type it" },
      },
      required: ["query"],
    },
    mutating: true,
    kind: "fetch",
    async execute({ signal }, args) {
      const query = typeof args.query === "string" ? args.query.trim().slice(0, 300) : "";
      if (!query) return { error: 'web_search requires a "query".' };
      const searchSignal = AbortSignal.any([signal, AbortSignal.timeout(SEARCH_TIMEOUT_MS)]);
      const found = await searchWeb(query, providers(searxngUrl()), { signal: searchSignal, limit: RESULT_LIMIT });
      if (signal.aborted) return { error: "Search cancelled." };
      if (!found) {
        return {
          output:
            "No web search provider returned results (they may be unreachable or blocked). Answer without web results and say so.",
        };
      }
      // In parallel so one slow page does not hold the rest; a failed page falls back to its snippet.
      const top = found.results.slice(0, PAGES_TO_READ);
      const settled = await Promise.allSettled(top.map((result) => openSearchPage(result.url, searchSignal)));
      const pages = new Map<string, Page | undefined>(
        top.map((result, index) => {
          const entry = settled[index];
          return [result.url, entry?.status === "fulfilled" ? entry.value : undefined];
        }),
      );
      return { output: formatSearchOutput(found.provider, query, found.results, pages) };
    },
  };
}
