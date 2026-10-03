import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Loaded with `node --import` before the test runner: every test process
 * inherits a throwaway home, so nothing a test does (sessions, credentials,
 * memory, background job logs, model capability cache) can touch the real
 * ~/.nova-ai of the developer running the suite.
 */
if (!process.env.NOVA_TEST_HOME) {
  const home = mkdtempSync(join(tmpdir(), "nova-test-home-"));
  process.env.NOVA_TEST_HOME = home;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.NOVA_AI_HOME = join(home, ".nova-ai");
}

// Nothing in the unit tests may reach the real Nova gateway: point clients at
// a closed local port unless a test starts its own fake server.
process.env.NOVA_BASE_URL ??= "http://127.0.0.1:9";
