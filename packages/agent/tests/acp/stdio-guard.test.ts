import assert from "node:assert/strict";
import { test } from "node:test";
import { redirectConsoleToStderr } from "../../src/acp/stdio-guard.js";

test("console output goes to stderr while the ACP guard is active", () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalOut = process.stdout.write.bind(process.stdout);
  const originalErr = process.stderr.write.bind(process.stderr);
  const originalError = console.error;
  console.error = (...args: unknown[]) => void stderr.push(args.join(" "));
  process.stdout.write = ((chunk: string) => (stdout.push(String(chunk)), true)) as typeof process.stdout.write;
  const restore = redirectConsoleToStderr();
  try {
    console.log("log");
    console.info("info");
    console.debug("debug");
  } finally {
    restore();
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
    console.error = originalError;
  }
  assert.deepEqual(stdout, []);
  assert.deepEqual(stderr, ["log", "info", "debug"]);
});
