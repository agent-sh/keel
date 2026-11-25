import { expect, test } from "bun:test";
import { cartoon } from "../providers/scripted-art.ts";
import { askedWith, cleanName, cleanPrompt, keepable, nameOf, startPrompt } from "./persona.ts";

test("a name is one short line; an empty one is the default", () => {
  expect(cleanName("  Pip  ")).toBe("Pip");
  expect(cleanName("Pip   the\thelper")).toBe("Pip the helper");
  expect(cleanName("")).toBeUndefined();
  expect(cleanName("a\u0007b")).toBeUndefined();
  expect(cleanName("x".repeat(41))).toBeUndefined();
  expect(cleanName(7)).toBeUndefined();
  expect(nameOf({})).toBe("Helper");
  expect(nameOf({ name: "Pip" })).toBe("Pip");
});

test("the description starts from the name and is asked with the lines that keep the picture usable small", () => {
  expect(startPrompt("Pip")).toContain("Pip");
  expect(askedWith("A fox in a scarf")).toContain("A fox in a scarf");
  expect(askedWith("A fox")).toContain("no text");
  expect(cleanPrompt("   ")).toBeUndefined();
  expect(cleanPrompt("x".repeat(601))).toBeUndefined();
  expect(cleanPrompt(" a fox ")).toBe("a fox");
});

test("an uploaded picture is kept as a PNG, JPEG or WebP within the limits; other bytes are refused with a reason", async () => {
  const ok = await keepable(cartoon("a"));
  expect("ext" in ok && ok.ext).toBe("png");
  expect(await keepable(new Uint8Array())).toEqual({ error: "the picture is empty" });
  expect(await keepable(new TextEncoder().encode("<html>no</html>"))).toMatchObject({ error: expect.stringContaining("not a PNG") });
  // A picture larger than the kept edge is scaled down.
  const big = new Uint8Array(await new Bun.Image(Buffer.from(cartoon("b"))).resize(1400, 1400).png().bytes());
  const kept = await keepable(big);
  expect("bytes" in kept).toBe(true);
  const meta = await new Bun.Image(Buffer.from((kept as { bytes: Uint8Array }).bytes)).metadata();
  expect(meta.width).toBe(512);
});
