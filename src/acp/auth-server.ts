import { exec } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NovaAI, NovaAIError } from "@datalabrotterdam/nova-sdk";
import { dir, json, WebServer } from "@sourceregistry/node-webserver";
import { credentialsPath, writeCredentials } from "./credentials.js";

const AUTH_TIMEOUT_MS = 5 * 60 * 1000;

function resolveUiDir(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // Running from src/acp/auth-server.ts via tsx.
    join(moduleDir, "web", "dist"),
    // Running from the bundled package entry in dist/index.js.
    join(moduleDir, "..", "src", "acp", "web", "dist"),
  ];

  const uiDir = candidates.find((candidate) => existsSync(candidate));
  if (!uiDir) {
    throw new Error(
      `Nova AI setup UI is missing. Expected it at one of: ${candidates.join(", ")}. Run npm run build before using --setup from a source checkout.`,
    );
  }

  return uiDir;
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? `open "${url}"`
      : process.platform === "win32"
        ? `start "" "${url}"`
        : `xdg-open "${url}"`;
  exec(cmd, () => {
    // best-effort; the URL is always printed as a fallback
  });
}

/**
 * Agent Auth flow (AUTHENTICATION.md, type "agent"): the agent itself runs a
 * local HTTP server and opens the browser. Today the page just collects a
 * Nova API key; swapping to real OAuth later means changing what this page
 * does (redirect to the provider's authorize URL, exchange the callback code)
 * without touching the server lifecycle or the rest of the agent.
 */
export function runBrowserAuth(): Promise<void> {
  return new Promise((resolve, reject) => {
    const app = new WebServer();
    const uiDir = resolveUiDir();

    app.POST("/api/authenticate", async (event) => {
      const body = await event.request.json().catch(() => null);
      const apiKey = typeof body?.apiKey === "string" ? body.apiKey.trim() : "";

      if (!apiKey) {
        return json({ message: "API key is required." }, { status: 400 });
      }

      try {
        const client = new NovaAI({ apiKey });
        const { data: models } = await client.models.list();
        const defaultModel = (models.find((m) => m.enabled !== false) ?? models[0])?.id;

        writeCredentials({ apiKey, defaultModel });

        clearTimeout(timeout);
        const response = json({ ok: true });
        void app.shutdown().then(resolve);
        return response;
      } catch (err) {
        const message =
          err instanceof NovaAIError
            ? `Nova AI rejected this key (status ${err.status}): ${err.message}`
            : "Unexpected error validating the key.";
        return json({ message }, { status: 401 });
      }
    });

    app.GET("/", dir(uiDir, { spa: true }));
    app.GET("/[...path]", dir(uiDir, { spa: true }));

    const timeout = setTimeout(() => {
      void app.shutdown();
      reject(new Error("Nova AI authentication timed out after 5 minutes."));
    }, AUTH_TIMEOUT_MS);

    app.listen(0, "127.0.0.1", () => {
      const address = app.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const url = `http://127.0.0.1:${port}`;
      console.error(`Opening browser to authenticate with Nova AI: ${url}`);
      openBrowser(url);
    });
  });
}

export { credentialsPath };
