// One self-contained binary: daemon + bundled UI (HTML import, Tailwind).
//   bun scripts/build.ts [OUT [TARGET]]   the binary (default dist/keel), and OUT-ui.tar.gz beside it
//   bun scripts/build.ts --ui OUT.tar.gz  only the UI bundle, for `keel ui install OUT.tar.gz`
//                                         (a running daemon built from the same src/ serves it at once)
// It runs from any folder: the sources and the default dist/ are the repository's,
// and an OUT that is given is taken from where the command runs. The build itself
// runs in the repository, since the styles are made from the files found there.
import tailwind from "bun-plugin-tailwind";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { sourceApi, UI_PREFIX, type UiManifest } from "../src/server/ui-bundle.ts";

const root = resolve(import.meta.dir, "..");
const outPath = (given: string | undefined, name: string) => (given ? resolve(given) : join(root, "dist", name));
const uiOnly = process.argv[2] === "--ui";
const out = uiOnly ? outPath(process.argv[3], "keel-ui.tar.gz") : outPath(process.argv[2], "keel");
process.chdir(root);
const t0 = performance.now();
const built = Date.now();
const api = sourceApi(root);
const define = { "process.env.NODE_ENV": '"production"' };
const fail = (res: Bun.BuildOutput) => {
  for (const l of res.logs) console.error(l);
  process.exit(1);
};

async function uiBundle(out: string) {
  const dir = mkdtempSync(join(tmpdir(), "keel-ui-"));
  try {
    const res = await Bun.build({ entrypoints: [join(root, "ui/index.html")], outdir: dir, target: "browser", minify: true, splitting: true, sourcemap: "none", publicPath: UI_PREFIX, plugins: [tailwind], define });
    if (!res.success) fail(res);
    const files: Record<string, Uint8Array> = {};
    const walk = (d: string): void => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) walk(p);
        else files[relative(dir, p)] = readFileSync(p);
      }
    };
    walk(dir);
    const manifest: UiManifest = { format: 1, version: built, api, files: Object.keys(files).sort() };
    mkdirSync(dirname(out), { recursive: true });
    await Bun.Archive.write(out, { ...files, "manifest.json": JSON.stringify(manifest, null, 1) }, { compress: "gzip" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (uiOnly) {
  await uiBundle(out);
  console.log(`built ${out} (UI ${built}, api ${api}) in ${((performance.now() - t0) / 1000).toFixed(2)}s`);
  process.exit(0);
}

// Another platform's binary: bun-linux-x64, bun-darwin-arm64, ...
const target = process.argv[3] as Bun.Build.Target | undefined;
// The helper an ssh machine runs (src/fleet/sshlink.ts), carried as text: the
// binary has no source to bundle it from.
const hands = await Bun.build({ entrypoints: [join(root, "src/fleet/hands-main.ts")], target: "bun", minify: true, define });
if (!hands.success) fail(hands);
const handsJs = await hands.outputs[0]!.text();
const res = await Bun.build({
  entrypoints: [join(root, "src/main.ts")],
  compile: target ? { outfile: out, target } : { outfile: out },
  minify: true,
  splitting: true,
  sourcemap: "none",
  plugins: [tailwind],
  define: { ...define, __KEEL_API__: JSON.stringify(api), __KEEL_UI_BUILT__: String(built), __KEEL_HANDS_JS__: JSON.stringify(handsJs) },
});
if (!res.success) fail(res);
await uiBundle(`${out}-ui.tar.gz`);
console.log(`built ${out} and ${out}-ui.tar.gz (api ${api}) in ${((performance.now() - t0) / 1000).toFixed(2)}s`);
