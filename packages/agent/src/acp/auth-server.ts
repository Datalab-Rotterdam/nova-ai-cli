import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NovaAI, NovaAIError } from "@datalabrotterdam/nova-sdk";
import { chooseDefaultModel } from "../core/model-capabilities.js";
import { createNovaClient } from "../core/nova-client.js";
import { dir, json, WebServer } from "@sourceregistry/node-webserver";
import {
  credentialsPath,
  writeCredentials,
  type StoredCredentials,
} from "../core/credentials.js";

const AUTH_TIMEOUT_MS = 5 * 60 * 1000;
const HOST = "127.0.0.1";

/** Header the setup page echoes the one-time token in; see web/src/App.svelte. */
export const SETUP_TOKEN_HEADER = "x-nova-setup-token";

function resolveUiDir(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // Running from src/acp/auth-server.ts via tsx.
    join(moduleDir, "web", "dist"),
    // Running from the compiled package (dist/acp/auth-server.js).
    join(moduleDir, "..", "..", "src", "acp", "web", "dist"),
  ];

  const uiDir = candidates.find((candidate) => existsSync(candidate));
  if (!uiDir) {
    throw new Error(
      `Nova AI setup UI is missing. Expected it at one of: ${candidates.join(", ")}. Run npm run build before using --setup from a source checkout.`,
    );
  }

  return uiDir;
}

/** Opens the URL without a shell, so nothing in it is ever interpreted. */
function openBrowser(url: string): void {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
        : ["xdg-open", [url]];
  try {
    spawn(command, args, { stdio: "ignore", detached: true })
      .on("error", () => {
        // best-effort; the URL is always printed as a fallback
      })
      .unref();
  } catch {
    // best-effort; the URL is always printed as a fallback
  }
}

/**
 * Checks a key against Nova and picks the default model: a chat model, with
 * native tool calls when there is one (never an embedding or speech model).
 */
export async function validateApiKey(apiKey: string): Promise<StoredCredentials> {
  const client = createNovaClient(apiKey);
  const { data: models } = await client.models.list({ limit: 100 });
  return { apiKey, defaultModel: chooseDefaultModel(models) };
}

export type AuthServerOptions = {
  uiDir?: string;
  timeoutMs?: number;
  validateApiKey?: (apiKey: string) => Promise<StoredCredentials>;
  writeCredentials?: (credentials: StoredCredentials) => void;
};

export type AuthServer = {
  /** Page to open; the one-time token travels in the fragment, so it never reaches logs or a Referer. */
  url: string;
  origin: string;
  token: string;
  /** Resolves once a valid key was stored; rejects on timeout or close. */
  done: Promise<void>;
  close(): Promise<void>;
};

/**
 * Agent Auth flow (AUTHENTICATION.md, type "agent"): the agent itself runs a
 * local HTTP server and opens the browser. Today the page just collects a
 * Nova API key; this will move to an OIDC binding with the Nova platform
 * (TODO(oidc), see credentials.ts): the page redirects to the authorize URL
 * and the server exchanges the callback code (PKCE) — without touching the
 * server lifecycle or the rest of the agent.
 *
 * Any web page the user visits can send requests to 127.0.0.1, so the key
 * endpoint only accepts requests that prove they come from our own page:
 * the Host must be our exact origin (defeats DNS rebinding), a present Origin
 * must match it, the body must be JSON, and the one-time token must be sent in
 * a custom header (which also forces a CORS preflight we never approve).
 * Without this, a malicious page could plant its own API key and receive the
 * user's prompts and code.
 */
export function startAuthServer(
  options: AuthServerOptions = {},
): Promise<AuthServer> {
  const uiDir = options.uiDir ?? resolveUiDir();
  const validate = options.validateApiKey ?? validateApiKey;
  const store = options.writeCredentials ?? writeCredentials;
  const token = randomBytes(32).toString("base64url");
  const expectedToken = Buffer.from(token);

  let resolveDone!: () => void;
  let rejectDone!: (error: Error) => void;
  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  // Callers that only await startAuthServer() must not see an unhandled rejection.
  done.catch(() => {});

  const app = new WebServer();
  let origin = "";
  let settled = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;

  const settle = (error?: Error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    const shutdown = app.shutdown().catch(() => {});
    if (error) void shutdown.then(() => rejectDone(error));
    else void shutdown.then(resolveDone);
  };

  app.POST("/api/authenticate", async (event) => {
    const rejection = rejectUntrustedRequest(
      event.request,
      origin,
      expectedToken,
    );
    if (rejection) return rejection;
    if (settled) {
      return json({ message: "Setup already finished." }, { status: 409 });
    }

    const body = await event.request.json().catch(() => null);
    const apiKey = typeof body?.apiKey === "string" ? body.apiKey.trim() : "";

    if (!apiKey) {
      return json({ message: "API key is required." }, { status: 400 });
    }

    try {
      store(await validate(apiKey));
    } catch (err) {
      const message =
        err instanceof NovaAIError
          ? `Nova AI rejected this key (status ${err.status}): ${err.message}`
          : "Unexpected error validating the key.";
      return json({ message }, { status: 401 });
    }

    // Let the response flush before the server stops accepting connections.
    setImmediate(() => settle());
    return json({ ok: true });
  });

  app.GET("/", dir(uiDir, { spa: true }));
  app.GET("/[...path]", dir(uiDir, { spa: true }));

  return new Promise((resolve, reject) => {
    app.listen(0, HOST, () => {
      const address = app.address();
      if (typeof address !== "object" || !address) {
        void app.shutdown().catch(() => {});
        reject(new Error("Nova AI setup server failed to bind."));
        return;
      }
      origin = `http://${HOST}:${address.port}`;
      timeout = setTimeout(
        () =>
          settle(
            new Error("Nova AI authentication timed out after 5 minutes."),
          ),
        options.timeoutMs ?? AUTH_TIMEOUT_MS,
      );
      resolve({
        url: `${origin}/#token=${token}`,
        origin,
        token,
        done,
        close: async () => {
          settle(new Error("Nova AI authentication was cancelled."));
          await done.catch(() => {});
        },
      });
    });
  });
}

function rejectUntrustedRequest(
  request: Request,
  origin: string,
  expectedToken: Buffer,
): ReturnType<typeof json> | null {
  const forbidden = () =>
    json(
      {
        message:
          "Request not allowed. Open the setup link printed by nova-ai-cli.",
      },
      { status: 403 },
    );

  if (!origin || request.headers.get("host") !== new URL(origin).host) {
    return forbidden();
  }
  const requestOrigin = request.headers.get("origin");
  if (requestOrigin !== null && requestOrigin !== origin) return forbidden();

  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.split(";")[0]!.trim().toLowerCase() !== "application/json") {
    return json(
      { message: "Content-Type must be application/json." },
      { status: 415 },
    );
  }

  const provided = Buffer.from(request.headers.get(SETUP_TOKEN_HEADER) ?? "");
  if (
    provided.length !== expectedToken.length ||
    !timingSafeEqual(provided, expectedToken)
  ) {
    return forbidden();
  }
  return null;
}

export async function runBrowserAuth(): Promise<void> {
  const server = await startAuthServer();
  console.error(`Opening browser to authenticate with Nova AI: ${server.url}`);
  openBrowser(server.url);
  await server.done;
}

export { credentialsPath };
