import { spawn } from "node:child_process";

/**
 * Copies text for /copy. OSC 52 asks the terminal itself to set the clipboard
 * (works over SSH; some terminals ignore it), and the system tool covers the
 * terminals that do: pbcopy, clip, wl-copy or xclip. Resolves with the tool
 * that took it, or null when only the escape sequence was sent.
 */
export async function copyText(
  text: string,
  write: (data: string) => void,
  tools: Array<[string, string[]]> = systemTools(),
): Promise<string | null> {
  write(`\u001b]52;c;${Buffer.from(text, "utf8").toString("base64")}\u0007`);
  for (const [command, args] of tools) {
    if (await pipeTo(command, args, text)) return command;
  }
  return null;
}

function systemTools(): Array<[string, string[]]> {
  if (process.platform === "darwin") return [["pbcopy", []]];
  if (process.platform === "win32") return [["clip", []]];
  return [["wl-copy", []], ["xclip", ["-selection", "clipboard"]]];
}

function pipeTo(command: string, args: string[], text: string): Promise<boolean> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ["pipe", "ignore", "ignore"] });
    } catch {
      resolve(false);
      return;
    }
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
    child.stdin.end(text);
  });
}
