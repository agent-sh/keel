// Pure logic of the session-operations routes the e2e cannot reach: what the
// editor command becomes, image kinds by bytes, a recap reply's shape, tags.
import { describe, expect, test } from "bun:test";
import { parseDigest } from "./convo.ts";
import { cleanTags } from "./marks.ts";
import { imageKind, openPlan } from "./places.ts";

describe("openPlan", () => {
  test("a configured template is filled, the request only names the file", () => {
    expect(openPlan({ KEEL_OPEN_COMMAND: "code -g {path}:{line}" }, "/w/a.ts", 7).argv).toEqual(["code", "-g", "/w/a.ts:7"]);
    expect(openPlan({ KEEL_EDITOR: "zed" }, "/w/a.ts").argv).toEqual(["zed", "/w/a.ts"]);
  });
  test("a windowed $VISUAL or $EDITOR opens the file; VS Code gets the line", () => {
    expect(openPlan({ VISUAL: "/usr/bin/code --wait" }, "/w/a.ts", 3)).toEqual({ argv: ["/usr/bin/code", "--wait", "-g", "/w/a.ts:3"], opened: "file" });
    expect(openPlan({ EDITOR: "subl" }, "/w/a.ts").argv).toEqual(["subl", "/w/a.ts"]);
  });
  test("a terminal editor or none opens the folder, never the file by its type", () => {
    const p = openPlan({ EDITOR: "vim" }, "/w/page.html");
    expect(p.opened).toBe("folder");
    expect(p.argv.at(-1)).toBe("/w");
  });
});

test("imageKind reads the bytes, not the name", () => {
  expect(imageKind(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]))).toBe("image/png");
  expect(imageKind(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
  expect(imageKind(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
  expect(imageKind(new TextEncoder().encode("<svg xmlns="))).toBeNull();
});

test("parseDigest takes JSON, fenced JSON or plain text, and caps the lengths", () => {
  expect(parseDigest('{"recap": "Tests pass.", "next": "ship it"}')).toEqual({ recap: "Tests pass.", next: "ship it" });
  expect(parseDigest('Here:\n```json\n{"recap": "Done.", "next": ""}\n```')).toEqual({ recap: "Done.", next: undefined });
  expect(parseDigest("The build is green.")).toEqual({ recap: "The build is green." });
  expect(parseDigest(JSON.stringify({ recap: "x".repeat(900) })).recap).toHaveLength(400);
});

test("cleanTags trims, drops repeats and refuses control characters", () => {
  expect(cleanTags([" a ", "A", "b", ""])).toEqual(["a", "b"]);
  expect(() => cleanTags(["bad\u0007"])).toThrow();
  expect(() => cleanTags("a")).toThrow();
});
