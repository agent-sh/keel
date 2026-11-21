// An install of a UI bundle is a transaction: the failures here are real ones
// of the file system (a path that is both a file and a folder, a folder where
// the pointer's draft goes), which no e2e can cause on a running daemon.
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UI_PREFIX, UiBundles } from "./ui-bundle.ts";

const API = "aaaaaaaaaaaaaaaa";
const made: string[] = [];
afterEach(() => { for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true }); });

const state = () => { const d = mkdtempSync(join(tmpdir(), "keel-ui-")); made.push(d); return d; };
const open = (dir: string, errors: Error[] = []) => new UiBundles(dir, API, { version: "embedded", built: 1 }, (e) => errors.push(e));
const bundle = (version: number, title: string, extra: Record<string, string> = {}) => {
  const files = { "index.html": `<html><head><title>${title}</title></head></html>`, [`chunk-${version}.js`]: `console.log(${JSON.stringify(title)})`, ...extra };
  return new Bun.Archive({ ...files, "manifest.json": JSON.stringify({ format: 1, version, api: API, files: Object.keys(files) }) }, { compress: "gzip" }).bytes();
};
// What a browser gets: the page, and the chunk of the bundle served (named by its build, as real chunks are).
const served = async (ui: UiBundles) => {
  const routes = ui.routes(["/"], { "/": () => new Response("<title>embedded</title>") });
  const page = await (routes["/"](new Request("http://x/")) as Response).text();
  const chunk = routes[`${UI_PREFIX}*`](new Request(`http://x${UI_PREFIX}chunk-${ui.active.version}.js`)) as Response;
  return { title: /<title>(.*?)<\/title>/.exec(page)?.[1], chunk: chunk.status === 200 ? await chunk.text() : chunk.status };
};
const kept = (ui: UiBundles) => { const s = ui.status(); return [s.active.version, s.current?.version, s.previous?.version]; };

test("the same bundle twice at once is one install, and other files under its version are refused", async () => {
  const dir = state();
  const ui = open(dir);
  await ui.install(await bundle(100, "first"));
  const twice = await bundle(200, "second");
  const done = await Promise.all([ui.install(twice), ui.install(twice), ui.install(twice)]);
  expect(done.map((m) => m.version)).toEqual([200, 200, 200]);
  expect(kept(ui)).toEqual(["200", 200, 100]);
  expect(await served(ui)).toEqual({ title: "second", chunk: 'console.log("second")' });

  const other = await ui.install(await bundle(200, "changed")).catch((e) => e);
  expect(other).toMatchObject({ status: 409, code: "version_conflict" });
  expect(kept(ui)).toEqual(["200", 200, 100]);
  expect(await served(ui)).toEqual({ title: "second", chunk: 'console.log("second")' });

  // The one kept for rollback, installed again, is served again and nothing is rewritten.
  await ui.install(await bundle(100, "first"));
  expect(kept(ui)).toEqual(["100", 100, 200]);
  expect(readdirSync(join(dir, "ui")).sort()).toEqual(["100", "200", "current.json"]);
});

for (const [name, fail] of [
  // "a" is written as a file, then "a/b" needs it to be a folder.
  ["while it is staged", async (_dir: string) => bundle(300, "third", { a: "file", "a/b": "inside" })],
  // The pointer's draft cannot be written where a folder stands.
  ["at the commit", async (dir: string) => { mkdirSync(join(dir, "ui", "current.json.part")); return bundle(300, "third"); }],
] as const) {
  test(`an install that fails ${name} leaves the page served and the one kept for rollback`, async () => {
    const dir = state();
    const ui = open(dir);
    await ui.install(await bundle(100, "first"));
    await ui.install(await bundle(200, "second"));

    await expect(ui.install(await fail(dir))).rejects.toThrow();
    expect(kept(ui)).toEqual(["200", 200, 100]);
    expect(await served(ui)).toEqual({ title: "second", chunk: 'console.log("second")' });
    expect(readdirSync(join(dir, "ui")).filter((d) => d !== "current.json.part").sort()).toEqual(["100", "200", "current.json"]);

    // A daemon started on the folder afterwards serves the same, and rolls back.
    const errors: Error[] = [];
    const again = open(dir, errors);
    expect(errors).toEqual([]);
    expect(kept(again)).toEqual(["200", 200, 100]);
    expect(await served(again)).toEqual({ title: "second", chunk: 'console.log("second")' });
    again.rollback();
    expect(kept(again)).toEqual(["100", 100, undefined]);
    expect((await served(again)).title).toBe("first");
    // And the next install goes through.
    await again.install(await bundle(400, "fourth"));
    expect(kept(again)).toEqual(["400", 400, 100]);
  });
}

test("what an install cut by a stop left is not served and goes at the next start", async () => {
  const dir = state();
  await open(dir).install(await bundle(100, "first"));
  // Cut while staging, and cut after the rename but before the pointer was replaced.
  mkdirSync(join(dir, "ui", ".stage-1-1"));
  writeFileSync(join(dir, "ui", ".stage-1-1", "index.html"), "<html><head><title>half");
  mkdirSync(join(dir, "ui", "900"));
  writeFileSync(join(dir, "ui", "900", "index.html"), "<html><head><title>uncommitted</title></head></html>");
  writeFileSync(join(dir, "ui", "current.json.part"), '{"current":9');

  const ui = open(dir);
  expect(kept(ui)).toEqual(["100", 100, undefined]);
  expect((await served(ui)).title).toBe("first");
  expect(readdirSync(join(dir, "ui")).sort()).toEqual(["100", "current.json"]);
  expect(existsSync(join(dir, "ui", "900"))).toBe(false);
});
