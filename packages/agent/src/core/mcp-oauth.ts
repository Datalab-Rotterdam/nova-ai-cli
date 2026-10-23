import { createHash, randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import {
  auth,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { novaHomeRoot, writePrivateFile } from "./nova-home.js";

/** How long a sign-in waits for the browser to come back. */
const AUTHORIZE_TIMEOUT_MS = 5 * 60_000;

/** Where a server's OAuth settings travel on an ACP McpServer (`oauth` in .mcp.json). */
export const OAUTH_META_KEY = "nova-ai-cli/oauth";

export type McpOAuthConfig = {
  /** A client registered by hand; without it Nova registers itself (dynamic client registration). */
  clientId?: string;
  clientSecret?: string;
  scope?: string;
  /** Fixed port for the redirect `http://127.0.0.1:<port>/callback`, for a client registered by hand. */
  callbackPort?: number;
};

/** One server's OAuth state, in ~/.nova-ai/mcp-auth (owner-only). */
type StoredAuth = {
  tokens?: OAuthTokens;
  /** The client Nova registered itself. */
  client?: OAuthClientInformationMixed;
  verifier?: string;
  discovery?: OAuthDiscoveryState;
  redirectUrl?: string;
};

/** The server wants the user to sign in, which only `_nova/mcp/login` can do. */
export class NeedsAuthError extends Error {
  constructor(server: string) {
    super(`MCP server "${server}" needs you to sign in (/mcp login ${server} in the TUI).`);
  }
}

export function oauthConfigOf(server: acp.McpServer): McpOAuthConfig {
  const value = server._meta?.[OAUTH_META_KEY];
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const config = value as Record<string, unknown>;
  const text = (key: string) => (typeof config[key] === "string" && config[key] ? (config[key] as string) : undefined);
  const port = config.callbackPort;
  return {
    clientId: text("clientId"),
    clientSecret: text("clientSecret"),
    scope: text("scope"),
    callbackPort: typeof port === "number" && Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined,
  };
}

function authPath(name: string, url: string): string {
  const key = createHash("sha256").update(`${name}\n${url}`).digest("hex").slice(0, 32);
  return join(novaHomeRoot(), "mcp-auth", `${key}.json`);
}

/**
 * The SDK's OAuth client for one HTTP/SSE server: discovery, dynamic client
 * registration, PKCE and refresh happen in the SDK's `auth()`. The redirect
 * is a loopback address (RFC 8252). Outside a sign-in it never opens a
 * browser: a server that needs one fails with NeedsAuthError.
 */
export class FileOAuthProvider implements OAuthClientProvider {
  private stored: StoredAuth;
  private expectedState?: string;
  /** Set during a sign-in: the loopback redirect and how to show the user the page. */
  private interactive?: { redirectUrl: string; open(url: URL): Promise<void> };
  private readonly path: string;

  constructor(
    private readonly server: string,
    url: string,
    private readonly config: McpOAuthConfig = {},
  ) {
    this.path = authPath(server, url);
    try {
      this.stored = JSON.parse(readFileSync(this.path, "utf8")) as StoredAuth;
    } catch {
      this.stored = {};
    }
  }

  get signedIn(): boolean {
    return !!this.stored.tokens;
  }

  get redirectUrl(): string | undefined {
    return this.interactive?.redirectUrl ?? this.stored.redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: this.redirectUrl ? [this.redirectUrl] : [],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: this.config.clientSecret ? "client_secret_post" : "none",
      client_name: "Nova AI",
      ...(this.config.scope ? { scope: this.config.scope } : {}),
    };
  }

  state(): string {
    this.expectedState = randomUUID();
    return this.expectedState;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    if (this.config.clientId) {
      return {
        client_id: this.config.clientId,
        ...(this.config.clientSecret ? { client_secret: this.config.clientSecret } : {}),
      };
    }
    // A registered client is bound to its redirect; a new loopback port needs a new registration.
    const client = this.stored.client as { redirect_uris?: string[] } | undefined;
    if (this.interactive && client?.redirect_uris && !client.redirect_uris.includes(this.interactive.redirectUrl)) {
      return undefined;
    }
    if (!this.interactive && !this.stored.client) throw new NeedsAuthError(this.server);
    return this.stored.client;
  }

  saveClientInformation(client: OAuthClientInformationMixed): void {
    this.save({ client });
  }

  tokens(): OAuthTokens | undefined {
    return this.stored.tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    this.save({ tokens });
  }

  async redirectToAuthorization(url: URL): Promise<void> {
    if (!this.interactive) throw new NeedsAuthError(this.server);
    await this.interactive.open(url);
  }

  saveCodeVerifier(verifier: string): void {
    this.save({ verifier });
  }

  codeVerifier(): string {
    if (!this.stored.verifier) throw new Error("No sign-in is in progress for this MCP server.");
    return this.stored.verifier;
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.stored.discovery;
  }

  saveDiscoveryState(discovery: OAuthDiscoveryState): void {
    this.save({ discovery });
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    if (scope === "all") this.forget();
    else this.save({ [scope]: undefined });
  }

  /** Signs out: forgets the tokens and the registered client. */
  forget(): void {
    this.stored = {};
    rmSync(this.path, { force: true });
  }

  /**
   * Signs in: `open` shows the user the authorization page, and a one-off
   * server on 127.0.0.1 receives the redirect.
   */
  async authorize(serverUrl: string, open: (url: URL) => Promise<void>, signal?: AbortSignal): Promise<void> {
    const callback = await listenForCallback(this.config.callbackPort ?? 0, (state) =>
      !!this.expectedState && state === this.expectedState,
    );
    try {
      const redirectUrl = `http://127.0.0.1:${callback.port}/callback`;
      this.interactive = { redirectUrl, open };
      this.save({ redirectUrl });
      if ((await auth(this, { serverUrl, scope: this.config.scope })) === "AUTHORIZED") return;
      const authorizationCode = await callback.code(signal);
      await auth(this, { serverUrl, scope: this.config.scope, authorizationCode });
    } finally {
      this.interactive = undefined;
      this.expectedState = undefined;
      callback.close();
    }
  }

  private save(change: Partial<StoredAuth>): void {
    this.stored = { ...this.stored, ...change };
    writePrivateFile(this.path, `${JSON.stringify(this.stored, null, 2)}\n`);
  }
}

type Callback = {
  port: number;
  /** The authorization code of the first redirect whose `state` checks out. */
  code(signal?: AbortSignal): Promise<string>;
  close(): void;
};

/** The redirect listener; it checks `state` from the start, as a fast browser can come back before `auth()` returns. */
export async function listenForCallback(
  port: number,
  checkState: (state: string | null) => boolean,
): Promise<Callback> {
  let settle!: (result: { code?: string; error?: string }) => void;
  const redirected = new Promise<{ code?: string; error?: string }>((resolve) => (settle = resolve));
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/callback") {
      response.writeHead(404).end();
      return;
    }
    const code = url.searchParams.get("code");
    const error = url.searchParams.get("error_description") ?? url.searchParams.get("error");
    const valid = checkState(url.searchParams.get("state"));
    const ok = valid && !!code && !error;
    response
      .writeHead(ok ? 200 : 400, { "Content-Type": "text/html; charset=utf-8" })
      .end(
        `<!doctype html><title>Nova AI</title><p>${ok ? "Signed in. You can close this tab." : "Sign-in failed. Return to Nova AI and try again."}</p>`,
      );
    if (valid) settle(ok ? { code: code! } : { error: error ?? "No authorization code was returned." });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  return {
    port: (server.address() as AddressInfo).port,
    code: (signal) =>
      new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Sign-in timed out.")), AUTHORIZE_TIMEOUT_MS);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("Sign-in was cancelled."));
        });
        void redirected.then((result) => {
          clearTimeout(timer);
          if (result.code) resolve(result.code);
          else reject(new Error(`Sign-in failed: ${result.error}`));
        });
      }),
    close: () => server.close(),
  };
}
