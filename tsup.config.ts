import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "node",
  target: "node18",
  outDir: "dist",
  dts: true,
  splitting: false,
  sourcemap: false,
  clean: true,
  shims: false,
  external: [
    "@agentclientprotocol/sdk",
    "@datalabrotterdam/nova-sdk",
    "@modelcontextprotocol/sdk",
    "@sourceregistry/node-webserver",
  ],
});
