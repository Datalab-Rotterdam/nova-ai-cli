import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyContentChanges,
  beginNesRequest,
  buildSuggestPrompt,
  changeNesDocument,
  closeNesSession,
  createNesSession,
  openNesDocument,
  parseSuggestResponse,
  selectPositionEncoding,
  uriToAbsolutePath,
  type NesDocument,
} from "../../src/acp/nes.js";

const document: NesDocument = {
  uri: "file:///a.ts",
  languageId: "typescript",
  version: 3,
  text: "const value = 1;\nconsole.log(value);\n",
};

describe("buildSuggestPrompt", () => {
  it("includes versioned document, cursor, selection, and rich context", () => {
    const prompt = buildSuggestPrompt({
      document,
      position: { line: 1, character: 5 },
      selection: {
        start: { line: 1, character: 0 },
        end: { line: 1, character: 7 },
      },
      triggerKind: "diagnostic",
      positionEncoding: "utf-16",
      workspaceUri: "file:///workspace",
      context: {
        diagnostics: [
          {
            uri: document.uri,
            range: {
              start: { line: 1, character: 0 },
              end: { line: 1, character: 7 },
            },
            severity: "warning",
            message: "Prefer a logger.",
          },
        ],
        editHistory: [{ uri: document.uri, diff: "+ console.log(value)" }],
      },
    });
    assert.match(prompt, /file:\/\/\/a\.ts/);
    assert.match(prompt, /Document version: 3/);
    assert.match(prompt, /line 1, character 5/);
    assert.match(prompt, /Selection: 1:0-1:7/);
    assert.match(prompt, /warning.*Prefer a logger/);
    assert.match(prompt, /1: console\.log\(value\);  < cursor/);
    assert.match(prompt, /Return JSON only/);
  });
});

describe("parseSuggestResponse", () => {
  it("parses a bounded JSON edit suggestion", () => {
    const raw = JSON.stringify({
      edits: [
        {
          range: {
            start: { line: 0, character: 14 },
            end: { line: 0, character: 15 },
          },
          newText: "2",
        },
      ],
      cursorPosition: { line: 0, character: 15 },
    });

    const suggestions = parseSuggestResponse(raw, document);
    assert.equal(suggestions.length, 1);
    const suggestion = suggestions[0];
    assert.equal(suggestion.kind, "edit");
    if (suggestion.kind !== "edit") throw new Error("Expected an edit.");
    assert.equal(suggestion.uri, document.uri);
    assert.deepEqual(suggestion.edits, [
      {
        range: {
          start: { line: 0, character: 14 },
          end: { line: 0, character: 15 },
        },
        newText: "2",
      },
    ]);
    assert.deepEqual(suggestion.cursorPosition, { line: 0, character: 15 });
  });

  it("accepts the original flat range shape for tolerant model parsing", () => {
    const raw = JSON.stringify({
      edits: [
        {
          startLine: 1,
          startChar: 0,
          endLine: 1,
          endChar: 7,
          newText: "logger",
        },
      ],
    });
    assert.equal(parseSuggestResponse(raw, document).length, 1);
  });

  it("validates cursor positions against the document after edits", () => {
    const shortDocument = { ...document, text: "x" };
    const suggestions = parseSuggestResponse(
      JSON.stringify({
        edits: [
          {
            range: {
              start: { line: 0, character: 1 },
              end: { line: 0, character: 1 },
            },
            newText: "\nnext",
          },
        ],
        cursorPosition: { line: 1, character: 4 },
      }),
      shortDocument,
    );
    assert.equal(suggestions.length, 1);
  });

  it("returns no suggestion for out-of-bounds or overlapping edits", () => {
    assert.deepEqual(
      parseSuggestResponse(
        JSON.stringify({
          edits: [
            {
              range: {
                start: { line: 20, character: 0 },
                end: { line: 20, character: 1 },
              },
              newText: "bad",
            },
          ],
        }),
        document,
      ),
      [],
    );
    assert.deepEqual(
      parseSuggestResponse(
        JSON.stringify({
          edits: [
            {
              range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 5 },
              },
              newText: "let",
            },
            {
              range: {
                start: { line: 0, character: 3 },
                end: { line: 0, character: 8 },
              },
              newText: "item",
            },
          ],
        }),
        document,
      ),
      [],
    );
  });

  it("returns an empty array for malformed JSON, no-op edits, or no edits", () => {
    assert.deepEqual(parseSuggestResponse("not json", document), []);
    assert.deepEqual(
      parseSuggestResponse(JSON.stringify({ edits: [] }), document),
      [],
    );
    assert.deepEqual(
      parseSuggestResponse(
        JSON.stringify({
          edits: [
            {
              range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 5 },
              },
              newText: "const",
            },
          ],
        }),
        document,
      ),
      [],
    );
  });
});

describe("NES documents", () => {
  it("applies full and incremental document changes", () => {
    assert.equal(
      applyContentChanges("old", [{ text: "new" }]),
      "new",
    );
    assert.equal(
      applyContentChanges("alpha\nbeta", [
        {
          range: {
            start: { line: 1, character: 0 },
            end: { line: 1, character: 4 },
          },
          text: "gamma",
        },
      ]),
      "alpha\ngamma",
    );
  });

  it("uses the negotiated encoding for Unicode character offsets", () => {
    const value = "a😀b";
    assert.equal(
      applyContentChanges(
        value,
        [
          {
            range: {
              start: { line: 0, character: 5 },
              end: { line: 0, character: 6 },
            },
            text: "c",
          },
        ],
        "utf-8",
      ),
      "a😀c",
    );
    assert.equal(
      applyContentChanges(
        value,
        [
          {
            range: {
              start: { line: 0, character: 2 },
              end: { line: 0, character: 3 },
            },
            text: "c",
          },
        ],
        "utf-32",
      ),
      "a😀c",
    );
  });

  it("tracks versions and cancels pending work on changes and close", () => {
    const session = createNesSession({ workspaceUri: "file:///workspace" });
    openNesDocument(session, {
      sessionId: "nes",
      uri: document.uri,
      languageId: "typescript",
      version: 1,
      text: "const a = 1;",
    });
    const pending = beginNesRequest(session, document.uri);
    changeNesDocument(
      session,
      {
        sessionId: "nes",
        uri: document.uri,
        version: 2,
        contentChanges: [{ text: "const a = 2;" }],
      },
      "utf-16",
    );
    assert.equal(pending.signal.aborted, true);
    assert.equal(session.documents.get(document.uri)?.version, 2);
    const next = beginNesRequest(session, document.uri);
    closeNesSession(session);
    assert.equal(next.signal.aborted, true);
    assert.equal(session.documents.size, 0);
  });
});

describe("NES protocol helpers", () => {
  it("converts file URIs to the absolute path required by ACP fs", () => {
    const path = uriToAbsolutePath("file:///C:/workspace/a.ts");
    assert.ok(path?.replace(/\\/g, "/").endsWith("C:/workspace/a.ts"));
    assert.equal(uriToAbsolutePath("untitled:Untitled-1"), null);
  });

  it("prefers UTF-16 but negotiates another supported encoding", () => {
    assert.equal(selectPositionEncoding(undefined), "utf-16");
    assert.equal(selectPositionEncoding(["utf-8"]), "utf-8");
    assert.equal(selectPositionEncoding(["utf-32"]), "utf-32");
    assert.equal(
      selectPositionEncoding(["utf-8", "utf-16"]),
      "utf-16",
    );
  });
});
