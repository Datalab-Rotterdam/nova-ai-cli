import { execFile } from "node:child_process";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_COMMAND_OUTPUT = 15 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export type ClipboardImage = {
  data: string;
  mimeType: "image/png";
  byteLength: number;
};

type Execute = (command: string, args: string[]) => Promise<Buffer>;

export async function readClipboardImage(
  options: { platform?: NodeJS.Platform | string; execute?: Execute } = {},
): Promise<ClipboardImage> {
  const platform = options.platform ?? process.platform;
  const execute = options.execute ?? executeFile;

  if (platform === "win32") {
    let base64: Buffer;
    try {
      base64 = await execute("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-STA",
        "-Command",
        WINDOWS_CLIPBOARD_SCRIPT,
      ]);
    } catch {
      throw new Error("No image was found on the clipboard.");
    }
    return fromBase64(base64.toString("utf8"));
  }

  if (platform === "darwin") {
    let base64: Buffer;
    try {
      base64 = await execute("osascript", [
        "-l",
        "JavaScript",
        "-e",
        MACOS_CLIPBOARD_SCRIPT,
      ]);
    } catch {
      throw new Error("No image was found on the clipboard.");
    }
    return fromBase64(base64.toString("utf8"));
  }

  if (platform === "linux") {
    const attempts: Array<[string, string[]]> = [
      ["wl-paste", ["--type", "image/png"]],
      ["xclip", ["-selection", "clipboard", "-t", "image/png", "-o"]],
    ];
    for (const [command, args] of attempts) {
      try {
        return fromPng(await execute(command, args));
      } catch {
        // Try the next common Wayland/X11 clipboard provider.
      }
    }
    throw new Error(
      "No PNG image was found on the clipboard. Install wl-clipboard (Wayland) or xclip (X11).",
    );
  }

  throw new Error(`Clipboard image paste is not supported on ${platform}.`);
}

function fromBase64(value: string): ClipboardImage {
  const normalized = value.replace(/\s+/g, "");
  if (!normalized || !/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
    throw new Error("The clipboard does not contain an image.");
  }
  return fromPng(Buffer.from(normalized, "base64"));
}

function fromPng(buffer: Buffer): ClipboardImage {
  if (buffer.length === 0 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("The clipboard does not contain a PNG image.");
  }
  if (buffer.length > MAX_IMAGE_BYTES) {
    throw new Error(
      `Clipboard image is too large (${formatBytes(buffer.length)}); maximum is ${formatBytes(MAX_IMAGE_BYTES)}.`,
    );
  }
  return {
    data: buffer.toString("base64"),
    mimeType: "image/png",
    byteLength: buffer.length,
  };
}

function executeFile(command: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        encoding: "buffer",
        maxBuffer: MAX_COMMAND_OUTPUT,
        timeout: 8_000,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout));
      },
    );
  });
}

function formatBytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

const WINDOWS_CLIPBOARD_SCRIPT = [
  "$image = Get-Clipboard -Format Image -ErrorAction Stop",
  "if ($null -eq $image) { throw 'Clipboard does not contain an image.' }",
  "$stream = [System.IO.MemoryStream]::new()",
  "try {",
  "  $image.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)",
  "  [Console]::Out.Write([Convert]::ToBase64String($stream.ToArray()))",
  "} finally {",
  "  $stream.Dispose()",
  "  $image.Dispose()",
  "}",
].join("\n");

const MACOS_CLIPBOARD_SCRIPT = `
ObjC.import('AppKit');
const pasteboard = $.NSPasteboard.generalPasteboard;
let data = pasteboard.dataForType('public.png');
if (!data) data = pasteboard.dataForType('public.tiff');
if (!data) throw new Error('Clipboard does not contain an image.');
const image = $.NSImage.alloc.initWithData(data);
const bitmap = $.NSBitmapImageRep.imageRepWithData(image.TIFFRepresentation);
const png = bitmap.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $.NSDictionary.dictionary);
console.log(ObjC.unwrap(png.base64EncodedStringWithOptions(0)));
`;
