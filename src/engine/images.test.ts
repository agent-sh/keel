import { expect, test } from "bun:test";
import type { Message } from "../core/types.ts";
import { withoutImages } from "./images.ts";

test("a text-only model gets a note in place of each image, in prompts and tool results", () => {
  const img = { type: "image", media_type: "image/png", data: "AA==" };
  const msgs = [
    { role: "user", content: [img, { type: "text", text: "look" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [img] }] },
  ] as unknown as Message[];
  const out = JSON.stringify(withoutImages(msgs, "m"));
  expect(out).not.toContain('"image"');
  expect(out.match(/image not sent: m does not read images/g)?.length).toBe(2);
  const plain = [{ role: "user", content: [{ type: "text", text: "hi" }] }] as Message[];
  expect(withoutImages(plain, "m")).toBe(plain);
});
