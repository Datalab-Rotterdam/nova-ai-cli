import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { describe, it } from "node:test";
import { runLogin, runLogout } from "../../src/commands/login.js";
import { readStoredCredentials } from "../../src/core/credentials.js";

function pipedIo(input: string) {
  const out: string[] = [];
  const err: string[] = [];
  const stdin = Readable.from([input]) as unknown as NodeJS.ReadStream;
  return {
    io: { stdin, stdout: { write: (c: string) => out.push(c) }, stderr: { write: (c: string) => err.push(c) } },
    out,
    err,
  };
}

async function withFetch(status: number, run: () => Promise<void>) {
  const previous = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      status === 200
        ? JSON.stringify({ object: "list", data: [{ id: "m1", object: "model", created: 0, owned_by: "x" }] })
        : JSON.stringify({ error: { message: "invalid key" } }),
      { status, headers: { "content-type": "application/json" } },
    )) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = previous;
  }
}

describe("nova-ai login / logout", () => {
  it("stores a piped key after validating it, and logout removes it", async () => {
    await withFetch(200, async () => {
      const { io, out } = pipedIo("  secret-key \n");
      assert.equal(await runLogin([], io), 0);
      assert.match(out.join(""), /Logged in/);
      assert.deepEqual(readStoredCredentials(), { apiKey: "secret-key", defaultModel: "m1" });
    });
    const logout: string[] = [];
    assert.equal(runLogout({ stdout: { write: (c: string) => logout.push(c) } }), 0);
    assert.equal(readStoredCredentials(), null);
    assert.match(logout.join(""), /removed/);
  });

  it("refuses a key Nova rejects and stores nothing", async () => {
    await withFetch(401, async () => {
      const { io, err } = pipedIo("bad-key\n");
      assert.equal(await runLogin([], io), 1);
      assert.match(err.join(""), /rejected/);
      assert.equal(readStoredCredentials(), null);
    });
  });

  it("rejects unknown options", async () => {
    const { io, err } = pipedIo("");
    assert.equal(await runLogin(["--bogus"], io), 2);
    assert.match(err.join(""), /Unknown option/);
  });
});
