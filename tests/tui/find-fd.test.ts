import assert from "node:assert/strict";
import test from "node:test";
import { resetFdPathCache, resolveFdPath } from "../../src/tui/files/find-fd.js";

test("resolveFdPath returns the first candidate that responds successfully", () => {
  resetFdPathCache();
  const tried: string[] = [];
  const path = resolveFdPath((command) => {
    tried.push(command);
    return { status: command === "fdfind" ? 0 : null, error: command === "fdfind" ? undefined : new Error("ENOENT") };
  });
  assert.equal(path, "fdfind");
  assert.deepEqual(tried, ["fd", "fdfind"]);
});

test("resolveFdPath returns null when no candidate is found", () => {
  resetFdPathCache();
  const path = resolveFdPath(() => ({ status: null, error: new Error("ENOENT") }));
  assert.equal(path, null);
});

test("resolveFdPath memoizes across calls", () => {
  resetFdPathCache();
  let calls = 0;
  const run = () => {
    calls += 1;
    return { status: 0 };
  };
  resolveFdPath(run);
  resolveFdPath(run);
  assert.equal(calls, 1);
});
