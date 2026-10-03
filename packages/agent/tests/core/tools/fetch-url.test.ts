import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { fetchUrlTool, parseUrl } from "../../../src/core/tools/fetch-url.js";
import { makeToolContext } from "./test-helpers.js";

let server: Server;
let base: string;

before(async () => {
  server = createServer((req, res) => {
    const page = req.url ?? "/";
    if (page === "/html") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        '<html><head><title>Guide</title><script>bad()</script></head><body><nav>menu</nav><h1>Install</h1><p>Run <code>npm i</code>, see <a href="/next">next</a>.</p></body></html>',
      );
    } else if (page === "/long") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("x".repeat(25_000));
    } else if (page === "/same-site") {
      res.writeHead(302, { location: "/html" });
      res.end();
    } else if (page === "/other-site") {
      // localhost vs 127.0.0.1: another origin than the approved URL.
      res.writeHead(302, { location: base.replace("127.0.0.1", "localhost") + "/html" });
      res.end();
    } else if (page === "/image") {
      res.writeHead(200, { "content-type": "image/png" });
      res.end("png");
    } else {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("missing");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => server.close());

const fetchUrl = async (args: Record<string, unknown>) => {
  const result = await fetchUrlTool.execute(makeToolContext(), args);
  return "output" in result ? result.output : `ERROR ${result.error}`;
};

describe("fetch_url", () => {
  it("needs approval and turns HTML into readable text", async () => {
    assert.equal(fetchUrlTool.mutating, true, "network egress is never automatic");
    const page = await fetchUrl({ url: `${base}/html` });
    assert.match(page, /^URL: http:\/\/127\.0\.0\.1:\d+\/html\nTitle: Guide/);
    assert.match(page, /# Install/);
    assert.match(page, /Run `npm i`, see \[next\]\(http:\/\/127\.0\.0\.1:\d+\/next\)/);
    assert.doesNotMatch(page, /bad\(\)|menu/);
  });

  it("cuts long pages and continues from start_char", async () => {
    assert.match(await fetchUrl({ url: `${base}/long` }), /Call fetch_url again with start_char=20000/);
    const rest = await fetchUrl({ url: `${base}/long`, start_char: 20_000 });
    assert.doesNotMatch(rest, /Page cut/);
    assert.equal(rest.split("\n\n")[1]!.length, 5_000);
  });

  it("follows redirects on the same site only", async () => {
    assert.match(await fetchUrl({ url: `${base}/same-site` }), /Title: Guide/);
    const other = await fetchUrl({ url: `${base}/other-site` });
    assert.match(other, /redirects to http:\/\/localhost:\d+\/html, which is another site/);
    assert.doesNotMatch(other, /Install/);
  });

  it("reports status codes and unreadable content, and refuses unsafe URLs", async () => {
    assert.match(await fetchUrl({ url: `${base}/missing` }), /^HTTP 404/);
    assert.match(await fetchUrl({ url: `${base}/image` }), /Cannot read image\/png/);
    assert.equal(parseUrl("file:///etc/passwd"), "Only http and https URLs can be fetched.");
    assert.equal(parseUrl("https://user:pw@example.com/"), "URLs with credentials are not allowed.");
    assert.match(String(parseUrl("not a url")), /not a valid absolute URL/);
  });
});
