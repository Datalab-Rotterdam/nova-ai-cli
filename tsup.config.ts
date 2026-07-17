import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  outDir: "dist",
  dts: true,
  splitting: false,
  sourcemap: false,
  clean: true,
  shims: false,
  external: [
    "@agentclientprotocol/sdk",
    "@earendil-works/pi-tui",
    "@datalabrotterdam/nova-sdk",
    "@modelcontextprotocol/sdk",
    "@sourceregistry/node-webserver",
  ],
});
