import assert from "node:assert/strict";
import test from "node:test";
import { readClipboardImage } from "../../src/tui/files/clipboard-image.js";
import { DraftImageAttachments } from "../../src/tui/files/prompt-images.js";

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);

test("Windows clipboard base64 is converted to a PNG attachment", async () => {
  const image = await readClipboardImage({
    platform: "win32",
    execute: async (command, args) => {
      assert.equal(command, "powershell.exe");
      assert.ok(args.includes("-STA"));
      return Buffer.from(PNG.toString("base64"));
    },
  });
  assert.equal(image.mimeType, "image/png");
  assert.equal(image.byteLength, PNG.length);
  assert.equal(image.data, PNG.toString("base64"));
});

test("Windows clipboard failures produce a concise user-facing error", async () => {
  await assert.rejects(
    () =>
      readClipboardImage({
        platform: "win32",
        execute: async () => {
          throw new Error("long PowerShell diagnostic");
        },
      }),
    new Error("No image was found on the clipboard."),
  );
});

test("Linux clipboard falls back from Wayland to X11", async () => {
  const commands: string[] = [];
  const image = await readClipboardImage({
    platform: "linux",
    execute: async (command) => {
      commands.push(command);
      if (command === "wl-paste") throw new Error("not installed");
      return PNG;
    },
  });
  assert.deepEqual(commands, ["wl-paste", "xclip"]);
  assert.equal(image.byteLength, PNG.length);
});

test("non-image clipboard data is rejected", async () => {
  await assert.rejects(
    () =>
      readClipboardImage({
        platform: "linux",
        execute: async () => Buffer.from("plain text"),
      }),
    /No PNG image was found/,
  );
});

test("draft images use stable markers and only submit referenced images", () => {
  const images = new DraftImageAttachments();
  const first = images.add({
    data: PNG.toString("base64"),
    mimeType: "image/png",
    byteLength: PNG.length,
  });
  const second = images.add({
    data: PNG.toString("base64"),
    mimeType: "image/png",
    byteLength: PNG.length,
  });
  assert.equal(first.marker, "[#Image1]");
  assert.equal(second.marker, "[#Image2]");
  assert.deepEqual(images.referencedBy(`Inspect ${second.marker}`), [second]);
  images.clear();
  assert.deepEqual(images.referencedBy(`Inspect ${second.marker}`), []);
});
