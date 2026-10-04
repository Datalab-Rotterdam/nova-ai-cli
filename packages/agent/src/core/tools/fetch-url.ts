import { readPackageVersion } from "../version.js";
import { htmlToText } from "./html-to-text.js";
import type { ToolDefinition } from "./types.js";

const FETCH_TIMEOUT_MS = 20_000;
const MAX_DOWNLOAD_BYTES = 3_000_000;
const PAGE_CHARS = 20_000;
const MAX_REDIRECTS = 5;

/**
 * Reads a web page for the model. Fetching sends a request to a third party
 * and can carry data out in the URL, so it is mutating (always asks unless a
 * rule allows the URL or the mode is bypass) and only follows redirects that
 * stay on the approved site; anything else is reported back and needs its
 * own call (and approval).
 */
export const fetchUrlTool: ToolDefinition = {
  name: "fetch_url",
  description:
    "fetch a web page (http or https) and return its main content as text with links, or the raw body for text and JSON. Use it for documentation, issues or articles the user refers to. Long pages are cut; pass start_char to read on. You cannot search the web: you need a concrete URL.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "absolute http(s) URL" },
      start_char: { type: "integer", description: "character offset to continue from (shown at the end of a cut page)" },
    },
    required: ["url"],
  },
  mutating: true,
  kind: "fetch",
  async execute({ signal }, args) {
    const url = parseUrl(args.url);
    if (typeof url === "string") return { error: url };
    const start = Math.max(0, Number(args.start_char ?? args.startChar ?? 0) || 0);
    return fetchPage(url, start, signal);
  },
};

export function parseUrl(value: unknown): URL | string {
  if (typeof value !== "string" || !value.trim()) return 'fetch_url requires a "url".';
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return `"${value}" is not a valid absolute URL.`;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "Only http and https URLs can be fetched.";
  if (url.username || url.password) return "URLs with credentials are not allowed.";
  return url;
}

async function fetchPage(
  url: URL,
  startChar: number,
  outer: AbortSignal,
): Promise<{ output: string } | { error: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  outer.addEventListener("abort", onAbort, { once: true });
  try {
    let current = url;
    let response: Response | undefined;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      response = await fetch(current, {
        signal: controller.signal,
        redirect: "manual",
        headers: {
          "User-Agent": `nova-ai-agent/${readPackageVersion() ?? "dev"} (+https://github.com/Datalab-Rotterdam/nova-ai-cli)`,
          Accept: "text/html,application/xhtml+xml,text/plain,text/markdown,application/json;q=0.9,*/*;q=0.5",
        },
      });
      const location = response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
      if (!location) break;
      await response.body?.cancel().catch(() => {});
      const next = new URL(location, current);
      if (next.origin !== url.origin) {
        return {
          output: `${current} redirects to ${next}, which is another site. Call fetch_url with that URL if you need it; it is a separate request.`,
        };
      }
      if (hop === MAX_REDIRECTS) return { error: `Too many redirects starting at ${url}.` };
      current = next;
    }
    if (!response) return { error: `Fetching ${url} failed.` };

    const contentType = response.headers.get("content-type") ?? "";
    const body = await readLimited(response, MAX_DOWNLOAD_BYTES);
    const status = response.ok ? "" : `HTTP ${response.status} ${response.statusText}\n`;
    let title: string | undefined;
    let text: string;
    if (/html|xml/i.test(contentType) || /^\s*<(!doctype|html)/i.test(body.slice(0, 200))) {
      ({ title, text } = htmlToText(body, current.toString()));
    } else if (/^(text\/|application\/(json|javascript|x-yaml|yaml|xml))/i.test(contentType) || !contentType) {
      text = body;
    } else {
      return { output: `${status}Cannot read ${contentType} content from ${current}.` };
    }

    const offset = Math.min(startChar, text.length);
    const slice = text.slice(offset, offset + PAGE_CHARS);
    const end = offset + slice.length;
    const more =
      end < text.length
        ? `\n\n[Page cut at character ${end} of ${text.length}. Call fetch_url again with start_char=${end} to read on.]`
        : "";
    const header = [`URL: ${current}`, title ? `Title: ${title}` : undefined].filter(Boolean).join("\n");
    return { output: `${status}${header}\n\n${slice || "(no readable text)"}${more}` };
  } catch (error) {
    if (controller.signal.aborted) {
      return { error: outer.aborted ? "Fetch cancelled." : `Fetching ${url} timed out after ${FETCH_TIMEOUT_MS / 1000}s.` };
    }
    return { error: `Fetching ${url} failed: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    clearTimeout(timer);
    outer.removeEventListener("abort", onAbort);
  }
}

async function readLimited(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    chunks.push(value);
    total += value.length;
    if (total >= maxBytes) {
      await reader.cancel();
      break;
    }
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}
