// Writes the package manager manifests for one release, from its SHA256SUMS:
//   Homebrew cask  -> packaging/homebrew/nova-ai.rb (stable) or nova-ai@alpha.rb (prerelease)
//   winget         -> packaging/winget/<version>/*.yaml (stable only: winget has no channels)
// and packs them as nova-ai-packaging.tar.gz next to the archives, for the GitHub release.
// Usage: node scripts/package-manifests.mjs --version <v> [--dir packages/cli/release]
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { version: { type: "string" }, dir: { type: "string", default: "release" } } });
const version = values.version;
if (!version || !/^[0-9A-Za-z.+-]+$/.test(version)) throw new Error("Pass --version <version>.");
const dir = resolve(values.dir);
const prerelease = version.includes("-");

const REPO = "https://github.com/Datalab-Rotterdam/nova-ai-cli";
const DESCRIPTION = "Agentic coding with DataLab Rotterdam's Nova AI in your terminal";
const downloadBase = `${REPO}/releases/download/%40datalabrotterdam%2Fnova-ai-cli%40${version}`;

const sums = new Map();
for (const line of readFileSync(join(dir, "SHA256SUMS"), "utf8").split("\n")) {
  const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(line.trim());
  if (match) sums.set(match[2], match[1]);
}
const sumOf = (asset) => {
  const sum = sums.get(asset);
  if (!sum) throw new Error(`${asset} is missing from SHA256SUMS.`);
  return sum;
};

const out = join(dir, "packaging");
rmSync(out, { recursive: true, force: true });

// Homebrew. Brew quarantines what it downloads and the binaries are not notarized yet, so the
// cask clears the flag after unpacking; drop postflight once they are.
mkdirSync(join(out, "homebrew"), { recursive: true });
const token = prerelease ? "nova-ai@alpha" : "nova-ai";
writeFileSync(
  join(out, "homebrew", `${token}.rb`),
  `cask "${token}" do
  arch arm: "arm64", intel: "x64"

  version "${version}"
  sha256 arm:   "${sumOf("nova-ai-darwin-arm64.tar.gz")}",
         intel: "${sumOf("nova-ai-darwin-x64.tar.gz")}"

  url "${REPO}/releases/download/%40datalabrotterdam%2Fnova-ai-cli%40#{version}/nova-ai-darwin-#{arch}.tar.gz",
      verified: "github.com/Datalab-Rotterdam/nova-ai-cli/"
  name "Nova AI"
  desc "${DESCRIPTION}"
  homepage "${REPO}"

  binary "nova-ai"

  postflight do
    system_command "/usr/bin/xattr",
                   args: ["-dr", "com.apple.quarantine", "#{staged_path}/nova-ai"],
                   must_succeed: false
  end

  zap trash: "~/.nova-ai"
end
`,
);

// winget: three files per version, the layout of microsoft/winget-pkgs.
if (!prerelease) {
  const id = "DatalabRotterdam.NovaAI";
  const folder = join(out, "winget", version);
  mkdirSync(folder, { recursive: true });
  const schema = "https://aka.ms/winget-manifest";
  const header = (kind) => `# yaml-language-server: $schema=${schema}.${kind}.1.6.0.schema.json\n\nPackageIdentifier: ${id}\nPackageVersion: ${version}\n`;
  const installer = (arch) => `  - Architecture: ${arch}
    InstallerUrl: ${downloadBase}/nova-ai-windows-${arch}.zip
    InstallerSha256: ${sumOf(`nova-ai-windows-${arch}.zip`).toUpperCase()}
`;
  writeFileSync(join(folder, `${id}.yaml`), `${header("version")}DefaultLocale: en-US\nManifestType: version\nManifestVersion: 1.6.0\n`);
  writeFileSync(
    join(folder, `${id}.installer.yaml`),
    `${header("installer")}InstallerType: zip
NestedInstallerType: portable
NestedInstallerFiles:
  - RelativeFilePath: nova-ai.exe
    PortableCommandAlias: nova-ai
Commands:
  - nova-ai
ReleaseDate: ${new Date().toISOString().slice(0, 10)}
Installers:
${installer("x64")}${installer("arm64")}ManifestType: installer
ManifestVersion: 1.6.0
`,
  );
  writeFileSync(
    join(folder, `${id}.locale.en-US.yaml`),
    `${header("defaultLocale")}PackageLocale: en-US
Publisher: DataLab Rotterdam
PublisherUrl: https://datalabrotterdam.nl
PackageName: Nova AI
PackageUrl: ${REPO}
License: Apache-2.0
LicenseUrl: ${REPO}/blob/main/LICENSE
ShortDescription: ${DESCRIPTION}
Tags:
  - ai
  - cli
  - agent
ReleaseNotesUrl: ${REPO}/releases/tag/%40datalabrotterdam%2Fnova-ai-cli%40${version}
ManifestType: defaultLocale
ManifestVersion: 1.6.0
`,
  );
}

execFileSync("tar", ["-czf", join(dir, "nova-ai-packaging.tar.gz"), "-C", dir, "packaging"]);
console.log(`Wrote ${join(dir, "nova-ai-packaging.tar.gz")} (${prerelease ? "cask only" : "cask and winget"})`);
