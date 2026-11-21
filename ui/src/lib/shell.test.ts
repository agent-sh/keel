import { expect, test } from "bun:test";
import { hexOf, pathParts } from "./shell.ts";

test("a path from the shell is read into what the page acts on", () => {
  expect(pathParts("/s/abc?approval=ap1")).toEqual({ pathname: "/s/abc", event: null, approval: "ap1", inbox: false });
  expect(pathParts("/s/abc?e=ev9")).toEqual({ pathname: "/s/abc", event: "ev9", approval: null, inbox: false });
  expect(pathParts("/?inbox=1")).toEqual({ pathname: "/", event: null, approval: null, inbox: true });
  expect(pathParts("/settings/safety")).toEqual({ pathname: "/settings/safety", event: null, approval: null, inbox: false });
});

test("a color is told as the bytes the canvas drew", () => {
  const px = new Uint8ClampedArray([14, 106, 128, 255]);
  const ctx = { fillStyle: "", fillRect() {}, clearRect() {}, getImageData: () => ({ data: px }) } as any;
  expect(hexOf("oklch(0.5 0.1 220)", ctx)).toBe("#0e6a80");
  expect(hexOf("  ", ctx)).toBeUndefined();
  expect(hexOf("red", null)).toBeUndefined();
});

test("a copied image the paste event did not carry is read from the clipboard", async () => {
  const { pastedImages } = await import("./images.ts");
  const png = new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" });
  const items = [
    { types: ["text/plain"], getType: async () => new Blob(["words"]) },
    { types: ["text/html", "image/png"], getType: async (t: string) => (t === "image/png" ? png : new Blob([])) },
  ];
  const files = await pastedImages(async () => items);
  expect(files.map((f) => [f.name, f.type, f.size])).toEqual([["pasted.png", "image/png", 4]]);
  expect(await pastedImages(async () => [])).toEqual([]);
});
