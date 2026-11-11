import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { gunzipSync } from "node:zlib";

/*
 * Support for the standalone binaries (scripts/build-binaries.mjs). A binary has no
 * package folders on disk: its generated entry calls configureStandalone() before anything
 * else, with the versions and an archive of the files that must exist as real files (the
 * setup page, the bundled skills, the browser host). Outside a binary nothing configures
 * this, standalone() is null and everything works from the npm packages.
 */
export type StandaloneConfig = {
  /** package name → version; package.json files are not available at run time. */
  versions: Record<string, string>;
  skillsVersion: string;
  /** Base64 of gzipped JSON: { "relative/path": "<base64 contents>" }. */
  archive: string;
};

let config: StandaloneConfig | null = null;
let assets: string | null = null;

export function configureStandalone(next: StandaloneConfig | null): void {
  config = next;
  assets = null;
}

export function standalone(): StandaloneConfig | null {
  return config;
}

/**
 * The per-user cache folder. Not the Nova home: its layout is shared with Nova AI for VS
 * Code (docs/NOVA_HOME.md). Not the temp folder either: the browser installer runs from
 * here, and other users can write there.
 */
export function runtimeCacheRoot(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  if (platform === "win32") return join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "nova-ai", "cache");
  if (platform === "darwin") return join(home, "Library", "Caches", "nova-ai");
  const xdg = env.XDG_CACHE_HOME;
  return join(xdg && isAbsolute(xdg) ? xdg : join(home, ".cache"), "nova-ai");
}

/**
 * Unpacks an archive to <cacheRoot>/runtime/<hash of the archive> and removes what other
 * versions left there. Writes to a temp folder first, so a half-written copy is never
 * used; of two starts racing, the loser uses the winner's copy.
 */
export function unpackAssets(archive: string, cacheRoot: string): string {
  const root = join(cacheRoot, "runtime");
  const name = createHash("sha256").update(archive).digest("hex").slice(0, 16);
  const target = join(root, name);
  if (!existsSync(target)) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const temp = join(root, `.tmp-${randomBytes(6).toString("hex")}`);
    try {
      const files = JSON.parse(gunzipSync(Buffer.from(archive, "base64")).toString("utf8")) as Record<string, string>;
      for (const [path, contents] of Object.entries(files)) {
        const file = join(temp, ...path.split("/"));
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, Buffer.from(contents, "base64"));
      }
      renameSync(temp, target);
    } catch (error) {
      if (!existsSync(target)) throw error;
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }
  for (const entry of readdirSync(root)) {
    if (entry !== name && !entry.startsWith(".")) {
      try {
        rmSync(join(root, entry), { recursive: true, force: true });
      } catch {
        // Still in use on Windows; the next start tries again.
      }
    }
  }
  return target;
}

/** Where this binary's files are, unpacked on first use. Throws outside a binary. */
export function standaloneAssets(): string {
  if (!config) throw new Error("Not running as a standalone binary.");
  return (assets ??= unpackAssets(config.archive, runtimeCacheRoot()));
}

/** installSkills options in a binary, where the skills package cannot find its own files. */
export function standaloneSkillSource(): { sourceDir: string; version: string } | undefined {
  if (!config) return undefined;
  return { sourceDir: join(standaloneAssets(), "skills"), version: config.skillsVersion };
}
