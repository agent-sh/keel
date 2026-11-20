// For hot-ui.spec.ts: a built UI bundle with a visible change (another title)
// and a newer version, optionally claiming other daemon sources.
// bun test/e2e/fixtures/repack-ui.ts IN OUT TITLE [API]  -> prints the version
const [inp, out, title, api] = process.argv.slice(2) as [string, string, string, string?];
const files = await new Bun.Archive(await Bun.file(inp).bytes()).files();
const next: Record<string, Uint8Array | string> = {};
for (const [name, f] of files) next[name] = await f.bytes();
const m = JSON.parse(await files.get("manifest.json")!.text());
m.version = Date.now();
if (api) m.api = api;
next["manifest.json"] = JSON.stringify(m);
next["index.html"] = (await files.get("index.html")!.text()).replace("<title>Keel</title>", `<title>${title}</title>`);
await Bun.Archive.write(out, next, { compress: "gzip" });
console.log(String(m.version));
