import { NovaAIError } from "@datalabrotterdam/nova-sdk";
import { runBrowserAuth, validateApiKey } from "../acp/auth-server.js";
import { credentialsPath, deleteCredentials, writeCredentials } from "../core/credentials.js";

export type LoginIo = {
  stdin: NodeJS.ReadStream;
  stdout: { write(chunk: string): unknown };
  stderr: { write(chunk: string): unknown };
};

const defaultIo = (): LoginIo => ({ stdin: process.stdin, stdout: process.stdout, stderr: process.stderr });

export const LOGIN_HELP = `Usage: nova-ai login [--no-browser]

Connects nova-ai to your Nova AI account and stores the API key in
${"~"}/.nova-ai/credentials.json (readable only by you).

  (default)       Opens a local page in your browser to enter the key
  --no-browser    Asks for the key in this terminal (input is hidden)
  piped stdin     Reads the key from stdin, e.g.  echo "$KEY" | nova-ai login

Get a key at https://platform.nova.datalabrotterdam.nl/dashboard/api-keys`;

/**
 * `nova-ai login`. Also the ACP "terminal" auth method: editors run
 * `nova-ai login --no-browser` in a terminal for the user.
 */
export async function runLogin(args: string[], io: LoginIo = defaultIo()): Promise<number> {
  const unknown = args.filter((arg) => arg !== "--no-browser" && arg !== "--help" && arg !== "-h");
  if (args.includes("--help") || args.includes("-h")) {
    io.stdout.write(`${LOGIN_HELP}\n`);
    return 0;
  }
  if (unknown.length) {
    io.stderr.write(`Unknown option: ${unknown[0]}\n\n${LOGIN_HELP}\n`);
    return 2;
  }

  if (!io.stdin.isTTY) {
    return storeKey((await readAll(io.stdin)).trim(), io);
  }
  if (args.includes("--no-browser")) {
    return storeKey((await readHidden(io, "Nova API key: ")).trim(), io);
  }
  try {
    await runBrowserAuth();
    io.stdout.write(`Logged in. The key is stored in ${credentialsPath()}.\n`);
    return 0;
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    io.stderr.write("Tip: run `nova-ai login --no-browser` to enter the key in this terminal.\n");
    return 1;
  }
}

export function runLogout(io: Pick<LoginIo, "stdout"> = defaultIo()): number {
  const removed = deleteCredentials();
  io.stdout.write(removed ? "Logged out: the stored API key was removed.\n" : "No stored API key to remove.\n");
  if (process.env.NOVA_API_KEY) {
    io.stdout.write("Note: NOVA_API_KEY is set in your environment and still logs you in.\n");
  }
  return 0;
}

async function storeKey(apiKey: string, io: LoginIo): Promise<number> {
  if (!apiKey) {
    io.stderr.write("No API key given.\n");
    return 1;
  }
  try {
    writeCredentials(await validateApiKey(apiKey));
  } catch (error) {
    io.stderr.write(
      error instanceof NovaAIError
        ? `Nova AI rejected this key (status ${error.status}): ${error.message}\n`
        : `Could not validate the key: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
  io.stdout.write(`Logged in. The key is stored in ${credentialsPath()}.\n`);
  return 0;
}

async function readAll(stream: NodeJS.ReadStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

/** Reads one line without echoing it (the key must not end up in scrollback). */
function readHidden(io: LoginIo, prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const { stdin } = io;
    io.stdout.write(prompt);
    let value = "";
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const finish = (error?: Error) => {
      stdin.setRawMode(wasRaw);
      stdin.pause();
      stdin.removeListener("data", onData);
      io.stdout.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") return finish();
        if (char === "\u0003") return finish(new Error("Login cancelled."));
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else if (char >= " ") value += char;
      }
    };
    stdin.on("data", onData);
  });
}
