import { expect, test } from "bun:test";
import { BROUGHT_MS, broughtHere, hexOf, pastedFiles, pathParts, wasBrought } from "./shell.ts";

// The review's case: a link raised the window and a card took the keyboard on its answer.
test("an arrival from outside the page holds the keyboard off the answers for a while, then no longer", () => {
  expect(wasBrought(1_000_000)).toBe(false);
  broughtHere(1_000_000);
  expect(wasBrought(1_000_001)).toBe(true);
  expect(wasBrought(1_000_000 + BROUGHT_MS - 1)).toBe(true);
  expect(wasBrought(1_000_000 + BROUGHT_MS)).toBe(false);
  broughtHere(-Infinity);
});

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

test("the pictures the app hands a paste are files", () => {
  const png = btoa(String.fromCharCode(137, 80, 78, 71));
  const files = pastedFiles([{ type: "text/plain", data: btoa("words") }, { type: "image/png", data: png }]);
  expect(files.map((f) => [f.name, f.type, f.size])).toEqual([["pasted.png", "image/png", 4]]);
  expect(pastedFiles([])).toEqual([]);
});
