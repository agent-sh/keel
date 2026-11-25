// The page's chunks as scripts/build.ts makes them, with what each holds and which chunks it imports:
// for the size budget (bundle-budget.test.ts) and for a look at what a first view loads.
import tailwind from "bun-plugin-tailwind";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { UI_PREFIX } from "../src/server/ui-bundle.ts";

export type Chunk = { bytes: number; inputs: Record<string, number>; static: string[]; dynamic: string[] };
export type PageGraph = { entry: string; chunks: Record<string, Chunk> };

const inputName = (k: string) => k.replace(/^(\.\.\/)+/, "").replace(/^.*?\/node_modules\//, "nm/");

// The graph of a page built with `metafile: true` (the result's metafile), by chunk file name.
export function graphOf(metafile: { outputs: Record<string, any> }): PageGraph {
  const chunks: Record<string, Chunk> = {};
  for (const [name, o] of Object.entries<any>(metafile.outputs)) {
    if (!name.endsWith(".js")) continue;
    const base = name.split("/").pop()!;
    const inputs: Record<string, number> = {};
    for (const [k, v] of Object.entries<any>(o.inputs ?? {})) inputs[inputName(k)] = v.bytesInOutput;
    const imports = o.imports as { path: string; kind: string }[];
    chunks[base] = {
      bytes: o.bytes, inputs,
      static: imports.filter((i) => i.kind === "import-statement").map((i) => i.path.split("/").pop()!),
      dynamic: imports.filter((i) => i.kind === "dynamic-import").map((i) => i.path.split("/").pop()!),
    };
  }
  // The page's script: the entry chunk that holds the app's own start (ui/src/main.tsx).
  const entry = Object.keys(chunks).find((c) => Object.keys(chunks[c]!.inputs).some((k) => k.endsWith("ui/src/main.tsx")))!;
  return { entry, chunks };
}

export async function pageGraph(root: string): Promise<PageGraph & { html: string }> {
  const top = resolve(root);
  const dir = mkdtempSync(join(tmpdir(), "keel-graph-"));
  const cwd = process.cwd();
  try {
    process.chdir(top);
    const res: any = await Bun.build({
      entrypoints: [join(top, "ui/index.html")], outdir: dir, target: "browser", minify: true, splitting: true, sourcemap: "none",
      publicPath: UI_PREFIX, plugins: [tailwind], define: { "process.env.NODE_ENV": '"production"' }, metafile: true,
    });
    if (!res.success) throw new Error(res.logs.join("\n"));
    return { ...graphOf(res.metafile), html: readFileSync(join(dir, "index.html"), "utf8") };
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
}

// The chunk that holds a source file, and every chunk it imports statically (what loads with it).
export function closureOf(g: PageGraph, file: string): Set<string> {
  const out = new Set<string>();
  const add = (c: string) => { if (out.has(c) || !g.chunks[c]) return; out.add(c); for (const s of g.chunks[c]!.static) add(s); };
  for (const [c, v] of Object.entries(g.chunks)) if (Object.keys(v.inputs).some((k) => k.endsWith(file))) add(c);
  return out;
}

export const sizeOf = (g: PageGraph, cs: Iterable<string>) => [...cs].reduce((n, c) => n + (g.chunks[c]?.bytes ?? 0), 0);
export const holds = (g: PageGraph, cs: Iterable<string>, file: string) => [...cs].some((c) => Object.keys(g.chunks[c]!.inputs).some((k) => k.endsWith(file)));

// What a wide window draws at its first view besides the entry: the bridge and the session list, each
// with the chunks it imports, and what the entry imports. The browser finds the shared ones only after it has read the chunk that
// imports them, a level at a time; named in the page they are fetched beside the entry, so the first
// paint does not wait for that chain.
export const WIDE_START = ["ui/src/components/Bridge.tsx", "ui/src/components/Sidebar.tsx"];
export function wideStart(g: PageGraph): string[] {
  const out = new Set<string>();
  const add = (c: string) => { if (c !== g.entry && !out.has(c)) { out.add(c); for (const s of g.chunks[c]!.static) add(s); } };
  for (const c of g.chunks[g.entry]!.static) add(c);
  for (const f of WIDE_START) {
    const c = closureOf(g, f);
    if (!c.size) throw new Error(`no chunk holds ${f}`);
    for (const n of c) add(n);
  }
  return [...out].sort();
}

// The page with those chunks named in its head, for a window that is not a phone's (a phone draws the
// list in a drawer, closed at the start, and fetches it after the page has settled: ui/src/App.tsx).
// A script, because a modulepreload link takes no media condition. It runs before the stylesheet's
// link, which holds back every script after it until the stylesheet has come.
export function withPreloads(html: string, g: PageGraph): string {
  const names = wideStart(g);
  const script = `<script>if(!matchMedia("(max-width:767px)").matches)for(var n of ${JSON.stringify(names)}){var l=document.createElement("link");l.rel="modulepreload";l.href=${JSON.stringify(UI_PREFIX)}+n;document.head.appendChild(l)}</script>`;
  const at = html.search(/<link rel="stylesheet"/);
  if (at < 0) throw new Error("the built page has no stylesheet link to put the preloads before");
  return html.slice(0, at) + script + html.slice(at);
}
