import { readPackageVersion } from "@datalabrotterdam/nova-ai-agent/core/version.js";

export const CLI_PACKAGE_NAME = "@datalabrotterdam/nova-ai-cli";

/** This (the CLI) package's version, not the agent's. */
export function cliVersion(): string | null {
  return readPackageVersion(CLI_PACKAGE_NAME, import.meta.url);
}
