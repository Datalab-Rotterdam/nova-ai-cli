import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { selectPassages } from "../../src/core/tools/passages.js";
import {
  createWebSearchTool,
  formatSearchOutput,
  searchProviders,
  searchWeb,
  type Page,
  type SearchProvider,
  type WebResult,
} from "../../src/core/tools/web-search.js";

describe("selectPassages", () => {
  it("returns the text unchanged when it fits the limit", () => {
    assert.equal(selectPassages("short text", "query", 100), "short text");
  });

  it("keeps the blocks that match the query and drops the rest", () => {
    const filler = " ".repeat(100).split("").join("x ");
    const text = [
      filler,
      "Some interesting fact about walruses and their tusks.",
      filler,
      "Generic padding text that matches nothing at all, but is long enough to stand alone as its own block. ".repeat(3),
      "Another fact about walrus habitats in the Arctic.",
    ].join("\n\n");
    const chosen = selectPassages(text, "walrus tusks habitat", 900);
    assert.match(chosen, /walruses and their tusks/);
    assert.match(chosen, /walrus habitats/);
    assert.doesNotMatch(chosen, /matches nothing/);
  });

  it("falls back to the start of the page when nothing matches", () => {
    const chosen = selectPassages("First words here.\n\n" + "y".repeat(500), "zzz not present", 100);
    assert.match(chosen, /First words here\./);
    assert.ok(chosen.length <= 100);
  });

  it("compares words without accents and marks gaps between far-apart matches", () => {
    const accented = "a".repeat(300) + "\n\nThe café serves croissants.\n\n" + "b".repeat(300);
    assert.match(selectPassages(accented, "cafée croissants", 400), /café/);
    const filler = " ".repeat(300).split("").join("p ");
    assert.match(selectPassages("alpha match here\n\n" + filler + "\n\nbeta match here", "alpha beta", 800), /…\n/);
  });
});

const results: WebResult[] = [
  { title: "Example", url: "https://a.test", snippet: "snippet a" },
  { title: "Other", url: "https://b.test", snippet: "snippet b" },
];

describe("web_search", () => {
  it("numbers sources with their opened passages, and snippets for pages it could not open", () => {
    const pages = new Map<string, Page | undefined>([
      ["https://a.test", { url: "https://a.test", title: "Example", text: "x".repeat(7000) + "\n\nThe matching answer here.\n\n" + "y".repeat(500) }],
      ["https://b.test", undefined],
    ]);
    const output = formatSearchOutput("You.com", "matching answer", results, pages);
    assert.match(output, /Cite the sources below as \[1\], \[2\], …/);
    assert.match(output, /\[1\] Example\nhttps:\/\/a\.test\n[\s\S]*The matching answer here\./);
    assert.match(output, /\[2\] Other\nhttps:\/\/b\.test\nsnippet b/);
  });

  it("falls through to the next provider when one fails or finds nothing", async () => {
    const failing: SearchProvider = { name: "Down", search: async () => { throw new Error("captcha"); } };
    const empty: SearchProvider = { name: "Empty", search: async () => [] };
    const working: SearchProvider = { name: "Works", search: async () => results };
    assert.deepEqual(await searchWeb("q", [failing, empty, working]), { provider: "Works", results });
    assert.equal(await searchWeb("q", [failing, empty]), undefined);
    assert.deepEqual(searchProviders("https://searx.example").map((provider) => provider.name), ["SearXNG", "You.com", "DuckDuckGo"]);
    assert.deepEqual(searchProviders(null).map((provider) => provider.name), ["You.com", "DuckDuckGo"]);
  });

  it("asks like fetch_url, needs a query and says when no provider answered", async () => {
    const seen: Array<string | null> = [];
    const tool = createWebSearchTool(
      () => "https://searx.example",
      (url) => {
        seen.push(url);
        return [{ name: "None", search: async () => [] }];
      },
    );
    assert.equal(tool.mutating, true);
    const ctx = { signal: new AbortController().signal } as never;
    assert.deepEqual(await tool.execute(ctx, {}), { error: 'web_search requires a "query".' });
    const result = await tool.execute(ctx, { query: "anything" });
    assert.ok("output" in result && /No web search provider returned results/.test(result.output));
    assert.deepEqual(seen, ["https://searx.example"]);
  });
});
