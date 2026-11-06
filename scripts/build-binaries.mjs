// Builds the standalone nova-ai binaries and packs them for a GitHub release. Bun cross-compiles,
// so one machine builds every target. Output: packages/cli/release/ (archives and SHA256SUMS).
// Usage (after npm run build): bun scripts/build-binaries.mjs [--version <v>] [--target <name>]
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { gzipSync } from "node:zlib";

const TARGETS = {
  "darwin-arm64": "bun-darwin-arm64",
  "darwin-x64": "bun-darwin-x64-baseline",
  "linux-arm64": "bun-linux-arm64",
  "linux-x64": "bun-linux-x64-baseline",
  "windows-arm64": "bun-windows-arm64",
  "windows-x64": "bun-windows-x64-baseline",
};

const root = resolve(import.meta.dir, "..");
const cliDir = join(root, "packages", "cli");
const agentDir = join(root, "packages", "agent");
const workDir = join(cliDir, ".binary");
const releaseDir = join(cliDir, "release");

const { values: args } = parseArgs({ options: { version: { type: "string" }, target: { type: "string" } } });
const packageOf = (dir) => JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
const cli = packageOf(cliDir);
const version = args.version ?? cli.version;
const names = args.target ? [args.target] : Object.keys(TARGETS);
for (const name of names) {
  if (!TARGETS[name]) throw new Error(`Unknown target ${name}. Choose from: ${Object.keys(TARGETS).join(", ")}`);
}

const packageDir = (name) => dirname(createRequire(join(cliDir, "package.json")).resolve(`${name}/package.json`));
const skillsDir = packageDir("@datalabrotterdam/nova-ai-skills");
const hostDir = packageDir("@datalabrotterdam/nova-ai-browser-host");

function filesBelow(dir) {
  if (statSync(dir).isFile()) return [dir];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "__pycache__") return [];
    const path = join(dir, entry.name);
    return entry.isDirectory() ? filesBelow(path) : [path];
  });
}

/** Everything that has to exist as real files at run time; see packages/agent/src/core/standalone.ts. */
function packAssets() {
  const sources = [
    ["setup-ui", join(agentDir, "src", "acp", "web", "dist"), "index.html"],
    ["skills", join(skillsDir, "skills"), "nova-docx"],
    ["browser-host/dist", join(hostDir, "dist"), "cli.js"],
    ["browser-host/skill", join(hostDir, "skill"), "nova-browser"],
    ["browser-host/package.json", join(hostDir, "package.json")],
  ];
  const archive = {};
  for (const [to, from, required] of sources) {
    if (!existsSync(join(from, required ?? ""))) throw new Error(`Missing ${join(from, required ?? "")}. Run npm run build first.`);
    for (const file of filesBelow(from)) {
      const path = file === from ? to : `${to}/${relative(from, file).split(sep).join("/")}`;
      archive[path] = readFileSync(file).toString("base64");
    }
  }
  return gzipSync(JSON.stringify(archive), { level: 9 }).toString("base64");
}

function writeEntry() {
  const config = {
    versions: { [cli.name]: version, [packageOf(agentDir).name]: packageOf(agentDir).version },
    skillsVersion: packageOf(skillsDir).version,
    archive: packAssets(),
  };
  const entry = join(workDir, "entry.ts");
  writeFileSync(
    entry,
    `import { configureStandalone } from "@datalabrotterdam/nova-ai-agent/core/standalone.js";
configureStandalone(${JSON.stringify(config)});
await import("../src/index.ts");
`,
  );
  return entry;
}

const bundlePlugin = {
  name: "nova-ai-binary",
  setup(build) {
    // Ink only loads this optional peer in dev mode, but a binary resolves every import at start.
    build.onResolve({ filter: /^react-devtools-core$/ }, () => ({ path: "react-devtools-core", namespace: "nova-empty" }));
    build.onLoad({ filter: /.*/, namespace: "nova-empty" }, () => ({ contents: "export default {};", loader: "js" }));
    // This package reads files next to itself on import unless it sees no import.meta.url, its
    // documented "bundled" mode. standaloneSkillSource() then says where the skills are.
    build.onLoad({ filter: /nova-ai-skills[/\\]index\.js$/ }, async ({ path }) => {
      const source = await Bun.file(path).text();
      const patched = source.replace(/^const base = .*$/m, "const base = undefined;");
      if (patched === source) throw new Error(`${path} changed: "const base = ..." not found.`);
      return { contents: patched, loader: "js" };
    });
  },
};

async function compile(entry, name) {
  const dir = join(workDir, name);
  const outfile = join(dir, name.startsWith("windows") ? "nova-ai.exe" : "nova-ai");
  mkdirSync(dir, { recursive: true });
  const result = await Bun.build({
    entrypoints: [entry],
    target: "bun",
    // Bun would otherwise load .env and bunfig.toml from whatever folder nova-ai is started in,
    // so a repository could point nova-ai at another gateway. Never turn these back on.
    compile: { target: TARGETS[name], outfile, autoloadDotenv: false, autoloadBunfig: false },
    define: { "process.env.NODE_ENV": '"production"' },
    minify: { whitespace: true, syntax: true },
    plugins: [bundlePlugin],
  });
  if (!result.success) throw new AggregateError(result.logs, `Compiling ${name} failed`);
  return outfile;
}

function run(command, cwd) {
  const { success, stderr } = Bun.spawnSync(command, { cwd, stderr: "pipe", stdout: "ignore" });
  if (!success) throw new Error(`${command.join(" ")} failed: ${stderr.toString()}`);
}

function pack(outfile, name) {
  const dir = dirname(outfile);
  const binary = outfile.slice(dir.length + 1);
  cpSync(join(cliDir, "LICENSE"), join(dir, "LICENSE"));
  const archive = join(releaseDir, `nova-ai-${name}.${name.startsWith("windows") ? "zip" : "tar.gz"}`);
  if (name.startsWith("windows")) run(["zip", "-q", archive, binary, "LICENSE"], dir);
  else run(["tar", "-czf", archive, binary, "LICENSE"], dir);
  return archive;
}

rmSync(workDir, { recursive: true, force: true });
rmSync(releaseDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });
mkdirSync(releaseDir, { recursive: true });

const entry = writeEntry();
const archives = [];
for (const name of names) {
  const archive = pack(await compile(entry, name), name);
  archives.push(archive);
  console.log(`${relative(root, archive)}: ${(statSync(archive).size / 1024 / 1024).toFixed(1)} MB`);
}
const sum = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
writeFileSync(
  join(releaseDir, "SHA256SUMS"),
  archives.map((file) => `${sum(file)}  ${relative(releaseDir, file)}\n`).join(""),
);
