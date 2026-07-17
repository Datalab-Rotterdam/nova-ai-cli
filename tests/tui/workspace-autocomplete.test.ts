import assert from "node:assert/strict";
import test from "node:test";
import { WorkspaceAutocompleteProvider } from "../../src/tui/files/workspace-autocomplete.js";

test("workspace autocomplete returns @file suggestions without fd", async () => {
  const provider = new WorkspaceAutocompleteProvider([], "C:\\workspace", [
    "src/components/MessageList.ts",
    "docs/file with spaces.md",
    "README.md",
  ]);

  const suggestions = await provider.getSuggestions(
    ["inspect @mess"],
    0,
    "inspect @mess".length,
    { signal: new AbortController().signal },
  );
  assert.ok(suggestions);
  assert.equal(suggestions.prefix, "@mess");
  assert.equal(suggestions.items[0]?.value, "@src/components/MessageList.ts");

  const quoted = await provider.getSuggestions(
    ['inspect @"spaces'],
    0,
    'inspect @"spaces'.length,
    { signal: new AbortController().signal },
  );
  assert.equal(quoted?.items[0]?.value, '@"docs/file with spaces.md"');
});

test("workspace autocomplete preserves slash-command completion", async () => {
  const provider = new WorkspaceAutocompleteProvider(
    [{ name: "skills", description: "Inspect skills" }],
    "C:\\workspace",
    [],
  );
  const suggestions = await provider.getSuggestions(
    ["/ski"],
    0,
    4,
    { signal: new AbortController().signal },
  );
  assert.equal(suggestions?.items[0]?.value, "skills");
});
