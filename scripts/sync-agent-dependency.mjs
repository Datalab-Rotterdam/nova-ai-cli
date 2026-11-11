// Points the CLI's dependency on the agent at the agent version in this
// checkout (the one just released, or the last release). Run between the
// agent's and the CLI's semantic-release: a range like ^1.0.0-alpha.1 would
// let npm install whatever the agent's `latest` tag points at, which is an
// older agent than the one the CLI was built and tested with.
import { readFileSync, writeFileSync } from "node:fs";

const AGENT = "@datalabrotterdam/nova-ai-agent";
const agentVersion = JSON.parse(readFileSync("packages/agent/package.json", "utf8")).version;
const cliPath = "packages/cli/package.json";
const cliText = readFileSync(cliPath, "utf8");
const cli = JSON.parse(cliText);
const range = `^${agentVersion}`;
if (cli.dependencies?.[AGENT] === range) {
  console.log(`${cliPath} already depends on ${AGENT}@${range}`);
} else {
  cli.dependencies[AGENT] = range;
  const indent = /^\s+/m.exec(cliText)?.[0] ?? "  ";
  writeFileSync(cliPath, `${JSON.stringify(cli, null, indent)}\n`);
  console.log(`${cliPath} now depends on ${AGENT}@${range}`);
}
