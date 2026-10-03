import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  outDir: "dist",
  dts: true,
  // Each mode (TUI, headless, ACP) is a dynamic import; splitting keeps
  // Ink and React out of `--acp`, `-p` and `--version`.
  splitting: true,
  sourcemap: false,
  clean: true,
  shims: false,
  external: [
    "@agentclientprotocol/sdk",
    "ink",
    "react",
    "@datalabrotterdam/nova-sdk",
    "@modelcontextprotocol/sdk",
    "@sourceregistry/node-webserver",
  ],
});
