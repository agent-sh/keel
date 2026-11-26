// For hot-ui.spec.ts: a built UI bundle with a visible change (another title)
// and a newer version, optionally claiming other daemon sources.
// bun test/e2e/fixtures/repack-ui.ts IN OUT TITLE [API]  -> prints the version
import { pageDigest } from "../../../src/core/api-stamp.ts";
const [inp, out, title, api] = process.argv.slice(2) as [string, string, string, string?];
const files = await new Bun.Archive(await Bun.file(inp).bytes()).files();
const next: Record<string, Uint8Array | string> = {};
for (const [name, f] of files) next[name] = await f.bytes();
const m = JSON.parse(await files.get("manifest.json")!.text());
m.version = Date.now();
if (api) m.api = api;
next["index.html"] = (await files.get("index.html")!.text()).replace("<title>Keel</title>", `<title>${title}</title>`);
const page: Record<string, Uint8Array> = {};
for (const name of m.files as string[]) page[name] = typeof next[name] === "string" ? new TextEncoder().encode(next[name] as string) : (next[name] as Uint8Array);
m.page = pageDigest(page);
next["manifest.json"] = JSON.stringify(m);
await Bun.Archive.write(out, next, { compress: "gzip" });
console.log(String(m.version));
