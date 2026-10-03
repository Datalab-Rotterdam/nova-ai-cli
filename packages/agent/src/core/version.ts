import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const AGENT_PACKAGE_NAME = "@datalabrotterdam/nova-ai-agent";

/**
 * A package's version, read at runtime so semantic-release's final version
 * wins. Walks up from `moduleUrl` to the package.json named `packageName`:
 * sources, compiled tests and bundles sit at different depths below it.
 * Defaults to this (the agent) package.
 */
export function readPackageVersion(
  packageName: string = AGENT_PACKAGE_NAME,
  moduleUrl: string = import.meta.url,
): string | null {
  let directory = dirname(fileURLToPath(moduleUrl));
  for (let depth = 0; depth < 10; depth++) {
    const candidate = join(directory, "package.json");
    if (existsSync(candidate)) {
      try {
        const metadata: unknown = JSON.parse(readFileSync(candidate, "utf8"));
        if (
          metadata &&
          typeof metadata === "object" &&
          (metadata as { name?: unknown }).name === packageName &&
          typeof (metadata as { version?: unknown }).version === "string"
        ) {
          return (metadata as { version: string }).version;
        }
      } catch {
        // not readable; keep looking further up
      }
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return null;
}
