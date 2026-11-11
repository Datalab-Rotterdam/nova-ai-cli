import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  outDir: "dist",
  // A command, not a library: no type declarations.
  dts: false,
  // Each mode (TUI, headless, ACP) is a dynamic import; splitting keeps
  // Ink and React out of `--acp`, `-p` and `--version`.
  splitting: true,
  sourcemap: false,
  clean: true,
  shims: false,
  // Every dependency stays external (tsup's default for `dependencies`),
  // including @datalabrotterdam/nova-ai-agent.
});
