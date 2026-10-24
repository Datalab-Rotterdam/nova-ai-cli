// Packs the agent and the CLI the way npm publishes them and checks the tarballs before a
// release: every file the packages need is there, and no tests, sources or source maps.
// Usage (after npm run build): node scripts/check-packages.mjs [out folder for the .tgz files]
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const REQUIRED = {
  "@datalabrotterdam/nova-ai-agent": [
    "package.json", "LICENSE", "README.md",
    "dist/index.js", "dist/index.d.ts", "dist/bin.js",
    // The browser sign-in page the agent serves (auth-server.ts).
    "src/acp/web/dist/index.html",
  ],
  "@datalabrotterdam/nova-ai-cli": ["package.json", "LICENSE", "README.md", "dist/index.js"],
};
const FORBIDDEN = [/^tests?\//, /(^|\/)node_modules\//, /\.test\.[jt]s$/, /\.map$/, /^src\/(?!acp\/web\/dist\/).*\.ts$/];

const out = resolve(process.argv[2] ?? "packages-out");
mkdirSync(out, { recursive: true });
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const packed = JSON.parse(execFileSync(npm, [
  "pack", "--json", "--pack-destination", out,
  ...Object.keys(REQUIRED).flatMap((name) => ["-w", name]),
], { encoding: "utf8", shell: process.platform === "win32" }));

let failed = false;
for (const { name, version, filename, files } of packed) {
  const paths = new Set(files.map((file) => file.path));
  const missing = (REQUIRED[name] ?? []).filter((path) => !paths.has(path));
  const extra = [...paths].filter((path) => FORBIDDEN.some((pattern) => pattern.test(path)));
  console.log(`${name}@${version}: ${paths.size} files (${filename})`);
  for (const path of missing) console.error(`  missing: ${path}`);
  for (const path of extra) console.error(`  should not ship: ${path}`);
  if (missing.length || extra.length) failed = true;
}
if (packed.length !== Object.keys(REQUIRED).length) {
  console.error(`Expected ${Object.keys(REQUIRED).length} packages, npm packed ${packed.length}.`);
  failed = true;
}

// The binaries start (only --version: no account, no network).
for (const bin of ["packages/agent/dist/bin.js", "packages/cli/dist/index.js"]) {
  console.log(`${bin} --version: ${execFileSync(process.execPath, [bin, "--version"], { encoding: "utf8" }).trim()}`);
}
process.exit(failed ? 1 : 0);
