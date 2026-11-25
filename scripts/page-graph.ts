// The page's chunks as scripts/build.ts makes them, with what each holds and which chunks it imports:
// for the size budget (bundle-budget.test.ts) and for a look at what a first view loads.
import tailwind from "bun-plugin-tailwind";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export type Chunk = { bytes: number; inputs: Record<string, number>; static: string[]; dynamic: string[] };
export type PageGraph = { entry: string; chunks: Record<string, Chunk> };

const inputName = (k: string) => k.replace(/^(\.\.\/)+/, "").replace(/^.*?\/node_modules\//, "nm/");

export async function pageGraph(root: string): Promise<PageGraph> {
  const top = resolve(root);
  const dir = mkdtempSync(join(tmpdir(), "keel-graph-"));
  const cwd = process.cwd();
  try {
    process.chdir(top);
    const res: any = await Bun.build({
      entrypoints: [join(top, "ui/index.html")], outdir: dir, target: "browser", minify: true, splitting: true, sourcemap: "none",
      publicPath: "/_ui/", plugins: [tailwind], define: { "process.env.NODE_ENV": '"production"' }, metafile: true,
    });
    if (!res.success) throw new Error(res.logs.join("\n"));
    const chunks: Record<string, Chunk> = {};
    let entry = "";
    for (const [name, o] of Object.entries<any>(res.metafile.outputs)) {
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
    entry = Object.keys(chunks).find((c) => Object.keys(chunks[c]!.inputs).some((k) => k.endsWith("ui/src/main.tsx")))!;
    return { entry, chunks };
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
