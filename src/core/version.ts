import { createRequire } from "node:module";

/**
 * This package's version, read at runtime so semantic-release's final
 * version wins. Source files, compiled tests and the bundled CLI sit at
 * different depths below package.json.
 */
export function readPackageVersion(): string | null {
  const require = createRequire(import.meta.url);
  for (const path of ["../package.json", "../../package.json", "../../../package.json"]) {
    try {
      const metadata: unknown = require(path);
      if (
        metadata &&
        typeof metadata === "object" &&
        (metadata as { name?: unknown }).name === "@datalabrotterdam/nova-ai-cli" &&
        typeof (metadata as { version?: unknown }).version === "string"
      ) {
        return (metadata as { version: string }).version;
      }
    } catch {
      // try the next depth
    }
  }
  return process.env.npm_package_version ?? null;
}
