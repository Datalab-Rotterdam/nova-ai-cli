import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  SETUP_TOKEN_HEADER,
  startAuthServer,
  type AuthServer,
} from "../../src/acp/auth-server.js";
import type { StoredCredentials } from "../../src/acp/credentials.js";

const uiDir = mkdtempSync(join(tmpdir(), "nova-auth-ui-"));
writeFileSync(join(uiDir, "index.html"), "<!doctype html><title>setup</title>");
after(() => rmSync(uiDir, { recursive: true, force: true }));

async function start(): Promise<{
  server: AuthServer;
  stored: StoredCredentials[];
}> {
  const stored: StoredCredentials[] = [];
  const server = await startAuthServer({
    uiDir,
    validateApiKey: async (apiKey) => ({ apiKey, defaultModel: "model-a" }),
    writeCredentials: (credentials) => stored.push(credentials),
  });
  return { server, stored };
}

function post(
  server: AuthServer,
  headers: Record<string, string>,
  body = JSON.stringify({ apiKey: "attacker-key" }),
): Promise<Response> {
  return fetch(`${server.origin}/api/authenticate`, {
    method: "POST",
    headers,
    body,
  });
}

describe("auth server", () => {
  it("puts the one-time token in the URL fragment only", async () => {
    const { server } = await start();
    try {
      const url = new URL(server.url);
      assert.equal(url.origin, server.origin);
      assert.equal(url.search, "");
      assert.equal(url.hash, `#token=${server.token}`);
      assert.ok(server.token.length >= 40);
    } finally {
      await server.close();
    }
  });

  it("rejects a cross-site form post without the token", async () => {
    const { server, stored } = await start();
    try {
      // What a malicious page can send without a CORS preflight.
      const res = await post(server, {
        "content-type": "text/plain",
        origin: "https://evil.example",
      });
      assert.equal(res.status, 403);
      assert.deepEqual(stored, []);
    } finally {
      await server.close();
    }
  });

  it("rejects a missing or wrong token", async () => {
    const { server, stored } = await start();
    try {
      assert.equal(
        (await post(server, { "content-type": "application/json" })).status,
        403,
      );
      assert.equal(
        (
          await post(server, {
            "content-type": "application/json",
            [SETUP_TOKEN_HEADER]: `${server.token.slice(0, -1)}x`,
          })
        ).status,
        403,
      );
      assert.deepEqual(stored, []);
    } finally {
      await server.close();
    }
  });

  it("rejects a foreign Origin even with the token", async () => {
    const { server, stored } = await start();
    try {
      const res = await post(server, {
        "content-type": "application/json",
        origin: "http://localhost:1234",
        [SETUP_TOKEN_HEADER]: server.token,
      });
      assert.equal(res.status, 403);
      assert.deepEqual(stored, []);
    } finally {
      await server.close();
    }
  });

  it("rejects non-JSON bodies even with the token", async () => {
    const { server, stored } = await start();
    try {
      const res = await post(server, {
        "content-type": "text/plain",
        [SETUP_TOKEN_HEADER]: server.token,
      });
      assert.equal(res.status, 415);
      assert.deepEqual(stored, []);
    } finally {
      await server.close();
    }
  });

  it("rejects a rebound Host header", async () => {
    const { server, stored } = await start();
    try {
      const { port } = new URL(server.origin);
      const body = JSON.stringify({ apiKey: "attacker-key" });
      const status = await new Promise<number>((resolve, reject) => {
        const req = httpRequest(
          {
            host: "127.0.0.1",
            port: Number(port),
            path: "/api/authenticate",
            method: "POST",
            headers: {
              host: `attacker.example:${port}`,
              "content-type": "application/json",
              "content-length": Buffer.byteLength(body),
              [SETUP_TOKEN_HEADER]: server.token,
            },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on("error", reject);
        req.end(body);
      });
      assert.equal(status, 403);
      assert.deepEqual(stored, []);
    } finally {
      await server.close();
    }
  });

  it("stores the key from its own page and then shuts down", async () => {
    const { server, stored } = await start();
    const res = await post(
      server,
      {
        "content-type": "application/json",
        origin: server.origin,
        [SETUP_TOKEN_HEADER]: server.token,
      },
      JSON.stringify({ apiKey: "  user-key  " }),
    );
    assert.equal(res.status, 200);
    await server.done;
    assert.deepEqual(stored, [{ apiKey: "user-key", defaultModel: "model-a" }]);
    await assert.rejects(post(server, { "content-type": "application/json" }));
  });

  it("rejects done when the timeout expires", async () => {
    const server = await startAuthServer({ uiDir, timeoutMs: 20 });
    await assert.rejects(server.done, /timed out/);
  });
});
