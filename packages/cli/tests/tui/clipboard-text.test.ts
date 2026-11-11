import assert from "node:assert/strict";
import { test } from "node:test";
import { copyText } from "../../src/tui/files/clipboard-text.js";

test("copyText asks the terminal to copy (OSC 52) and reports the system tool that took it", async () => {
  const written: string[] = [];
  assert.equal(await copyText("héllo", (data) => written.push(data), []), null);
  assert.deepEqual(written, [`\u001b]52;c;${Buffer.from("héllo").toString("base64")}\u0007`]);
  // A tool that is missing is skipped; the next one takes it.
  assert.equal(await copyText("x", () => {}, [["nova-no-such-tool", []], [process.execPath, ["-e", "process.stdin.resume()"]]]), process.execPath);
});
