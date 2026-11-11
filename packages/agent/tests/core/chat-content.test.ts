import assert from "node:assert/strict";
import test from "node:test";
import { chatContentToText } from "../../src/core/chat-content.js";

test("multimodal chat content restores text without exposing image data", () => {
  const value = chatContentToText([
    { type: "text", text: "Explain [#Image1]" },
    {
      type: "image_url",
      image_url: { url: "data:image/png;base64,a-very-large-value" },
    },
  ]);
  assert.equal(value, "Explain [#Image1]");
  assert.doesNotMatch(value, /base64/);
});

test("image-only chat content gets a readable placeholder", () => {
  assert.equal(
    chatContentToText([{ type: "image_url", image_url: { url: "data:" } }]),
    "[image]",
  );
});
