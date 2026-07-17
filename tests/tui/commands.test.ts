import assert from "node:assert/strict";
import test from "node:test";
import { builtinCommands } from "../../src/tui/commands/builtins.js";
import type { SlashCommandContext } from "../../src/tui/commands/types.js";

test("/compact invokes context compaction and reports what was retained", async () => {
  let output = "";
  const command = builtinCommands.find((entry) => entry.name === "compact");
  assert.ok(command);
  const context = {
    compactContext: async () => ({
      compacted: true,
      history: [],
      removedMessages: 18,
      keptMessages: 6,
    }),
    print: (text: string) => {
      output = text;
    },
  } as unknown as SlashCommandContext;

  await command.run(context, "");
  assert.match(output, /summarized 18 older messages/);
  assert.match(output, /kept 6 recent messages/);
});

test("/usage opens the context usage inspector", async () => {
  let opened = 0;
  const command = builtinCommands.find((entry) => entry.name === "usage");
  assert.ok(command);
  const context = {
    openUsageInspector: async () => {
      opened++;
    },
  } as unknown as SlashCommandContext;

  await command.run(context, "");
  assert.equal(opened, 1);
});

test("/session and /sessions open the same session picker", async () => {
  let opened = 0;
  const context = {
    openSessionSwitcher: () => {
      opened++;
    },
  } as unknown as SlashCommandContext;

  for (const name of ["session", "sessions"]) {
    const command = builtinCommands.find((entry) => entry.name === name);
    assert.ok(command);
    await command.run(context, "");
  }

  assert.equal(opened, 2);
});
