// Bundle budget: builds the UI for the browser and prints each chunk with its
// gzip size, and the largest inputs of the entry chunk. `bun scripts/measure-ui.ts DIR`
import tailwind from "bun-plugin-tailwind";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

const out = process.argv[2] ?? `${process.env.HOME}/.cache/keel-ui-measure`;
const r = await Bun.build({
  entrypoints: ["ui/index.html"], outdir: out, minify: true, splitting: true, target: "browser",
  plugins: [tailwind], define: { "process.env.NODE_ENV": "\"production\"" }, metafile: true, loader: { ".woff2": "file" },
} as any);
if (!r.success) { console.log(r.logs); process.exit(1); }
for (const o of r.outputs) {
  const b = readFileSync(o.path);
  console.log(`${o.path.replace(out, "").padEnd(32)} ${(b.length / 1024).toFixed(1).padStart(8)} KB  gzip ${(gzipSync(b).length / 1024).toFixed(1).padStart(7)} KB`);
}
const meta: any = (r as any).metafile;
if (meta && process.argv.includes("--inputs")) {
  for (const [name, o] of Object.entries<any>(meta.outputs)) {
    if (!name.endsWith(".js") || !o.inputs) continue;
    const by = new Map<string, number>();
    for (const [k, v] of Object.entries<any>(o.inputs)) {
      const pkg = k.match(/node_modules\/((?:@[^/]+\/)?[^/]+)/)?.[1] ?? "app";
      by.set(pkg, (by.get(pkg) ?? 0) + (v.bytesInOutput ?? 0));
    }
    console.log(name);
    for (const [k, v] of [...by].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`  ${k.padEnd(36)} ${(v / 1024).toFixed(1)} KB`);
  }
}
