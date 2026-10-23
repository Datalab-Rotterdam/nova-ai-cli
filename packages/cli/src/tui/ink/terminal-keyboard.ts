/** Kitty keyboard protocol query; supporting terminals answer `ESC [ ? flags u`. */
const KITTY_QUERY = "\u001b[?u";
/** Primary device attributes; virtually every terminal answers `ESC [ ? … c`. */
const DEVICE_ATTRIBUTES_QUERY = "\u001b[c";
const KITTY_REPLY = /\u001b\[\?\d+u/g;
const DEVICE_ATTRIBUTES_REPLY = /\u001b\[\?[\d;]*c/g;

export type ProbeInput = {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?(mode: boolean): unknown;
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  off(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  pause(): unknown;
  unshift(chunk: Buffer): unknown;
};

export type ProbeOutput = { isTTY?: boolean; write(data: string): unknown };

/**
 * Whether the terminal speaks the kitty keyboard protocol, which is what lets
 * it report Shift+Enter apart from Enter.
 *
 * The device-attributes query answers right after the kitty query, so a
 * terminal without kitty support is known within one round trip instead of a
 * fixed timeout. Keys typed meanwhile are handed back to the input exactly
 * once (Ink's own probe reads them twice).
 */
export function detectKittyKeyboard(
  stdin: ProbeInput,
  stdout: ProbeOutput,
  timeoutMs = 1_000,
): Promise<boolean> {
  if (!stdin.isTTY || !stdout.isTTY || !stdin.setRawMode) return Promise.resolve(false);
  const wasRaw = stdin.isRaw ?? false;
  stdin.setRawMode(true);

  return new Promise((resolve) => {
    let received = "";
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stdin.off("data", onData);
      stdin.pause();
      const supported = new RegExp(KITTY_REPLY.source).test(received);
      const typed = received.replace(KITTY_REPLY, "").replace(DEVICE_ATTRIBUTES_REPLY, "");
      if (typed) stdin.unshift(Buffer.from(typed, "utf8"));
      stdin.setRawMode?.(wasRaw);
      resolve(supported);
    };
    const onData = (chunk: Buffer | string) => {
      received += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (new RegExp(DEVICE_ATTRIBUTES_REPLY.source).test(received)) finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    stdin.on("data", onData);
    stdout.write(`${KITTY_QUERY}${DEVICE_ATTRIBUTES_QUERY}`);
  });
}

/**
 * NOVA_KITTY_KEYBOARD=1 or 0 skips the probe; otherwise the terminal is
 * asked (see detectKittyKeyboard).
 */
export function kittyKeyboardOverride(env: NodeJS.ProcessEnv = process.env): boolean | null {
  if (env.NOVA_KITTY_KEYBOARD === "1") return true;
  if (env.NOVA_KITTY_KEYBOARD === "0") return false;
  return null;
}

/** A terminal reply that arrived too late for the probe (Ink drops the ESC). */
export function isLateTerminalReply(input: string): boolean {
  return /^\u001b?\[\?[\d;]*[uc]$/.test(input);
}

/** Mouse button reports in SGR form; Ink hands them to `useInput` without the ESC. */
export const MOUSE_REPORTING_ON = "\u001b[?1000h\u001b[?1006h";
export const MOUSE_REPORTING_OFF = "\u001b[?1000l\u001b[?1006l";
const MOUSE_INPUT = /^\u001b?\[<(\d+);\d+;\d+[Mm]$/;

export function isMouseInput(input: string): boolean {
  return MOUSE_INPUT.test(input);
}

/** Rows to scroll for a wheel report (+ older, - newer); 0 for other mouse input. */
export function wheelRows(input: string): number {
  const button = Number(MOUSE_INPUT.exec(input)?.[1] ?? -1);
  if (button < 0 || (button & 64) === 0) return 0;
  return button & 1 ? -3 : 3;
}
