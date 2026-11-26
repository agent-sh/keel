// One self-contained binary: daemon + bundled UI (Tailwind). The page is
// compiled once per run; the binary embeds its files and the UI bundle packs them.
//   bun scripts/build.ts [OUT [TARGET]]   the binary (default dist/keel), and OUT-ui.tar.gz beside it
//   bun scripts/build.ts --ui OUT.tar.gz  only the UI bundle, for `keel ui install OUT.tar.gz`
//                                         (a running daemon whose binary was compiled from the same files serves it at once)
// It runs from any folder: the sources and the default dist/ are the repository's,
// and an OUT that is given is taken from where the command runs. The build itself
// runs in the repository, since the styles are made from the files found there.
import tailwind from "bun-plugin-tailwind";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { graphOf, withPreloads } from "./page-graph.ts";
import { UI_PREFIX, type UiManifest } from "../src/server/ui-bundle.ts";
import { binaryGraph, importGraph, pageDigest, sourceApi } from "../src/core/api-stamp.ts";

const root = resolve(import.meta.dir, "..");
const outPath = (given: string | undefined, name: string) => (given ? resolve(given) : join(root, "dist", name));
const uiOnly = process.argv[2] === "--ui";
const out = uiOnly ? outPath(process.argv[3], "keel-ui.tar.gz") : outPath(process.argv[2], "keel");
process.chdir(root);
const t0 = performance.now();
const built = Date.now();
// The daemon's sources are its import graph: what the UI bundle is checked against (src/core/api-stamp.ts).
const graph = binaryGraph(root);
const api = sourceApi(root, graph);
// The revision a binary says it is (`keel --version`): the commit, marked when the tree differs from it.
const git = (...args: string[]) => {
  const r = Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "ignore" });
  return r.exitCode === 0 ? r.stdout.toString().trim() : null;
};
const head = git("rev-parse", "HEAD");
const revision = head ? head + (git("status", "--porcelain") ? "-dirty" : "") : "unknown";
const define = { "process.env.NODE_ENV": '"production"' };
const fail = (res: Bun.BuildOutput) => {
  for (const l of res.logs) console.error(l);
  process.exit(1);
};

// The production page, compiled once per run (one browser graph, one pass of
// the stylesheet): its files by name. The binary embeds these very files and
// the UI bundle packs them, so the two always hold the same page.
async function browserGraph(): Promise<Record<string, Uint8Array>> {
  const dir = mkdtempSync(join(tmpdir(), "keel-ui-"));
  try {
    const t = performance.now();
    const res = await Bun.build({ entrypoints: [join(root, "ui/index.html")], outdir: dir, target: "browser", minify: true, splitting: true, sourcemap: "none", publicPath: UI_PREFIX, plugins: [tailwind], define, metafile: true });
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
    // A wide window's first view draws the bridge and the session list: their chunks are named in the page.
    files["index.html"] = new TextEncoder().encode(withPreloads(new TextDecoder().decode(files["index.html"]), graphOf(res.metafile)));
    const bytes = Object.values(files).reduce((n, f) => n + f.length, 0);
    console.log(`browser graph: ${Object.keys(files).length} files, ${(bytes / 1024).toFixed(0)} KB in ${((performance.now() - t) / 1000).toFixed(2)}s`);
    return files;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function pack(out: string, files: Record<string, Uint8Array>) {
  const manifest: UiManifest = { format: 1, version: built, api, page: pageDigest(files), revision, files: Object.keys(files).sort() };
  mkdirSync(dirname(out), { recursive: true });
  await Bun.Archive.write(out, { ...files, "manifest.json": JSON.stringify(manifest, null, 1) }, { compress: "gzip" });
}

const files = await browserGraph();
if (uiOnly) {
  await pack(out, files);
  console.log(`built ${out} (UI ${built}, api ${api}) in ${((performance.now() - t0) / 1000).toFixed(2)}s`);
  process.exit(0);
}

// Another platform's binary: bun-linux-x64, bun-darwin-arm64, ...
const target = process.argv[3] as Bun.Build.Target | undefined;
// The helper an ssh machine runs (src/fleet/sshlink.ts), carried as text: the
// binary has no source to bundle it from.
// What the binary's builds read from the repository, checked against the graph its api stamp hashes.
const read = new Set<string>();
const note = (res: Bun.BuildOutput) => {
  for (const i of Object.keys((res as any).metafile?.inputs ?? {})) if (!i.includes("node_modules/") && !i.includes(":") && !i.startsWith("..") && !i.startsWith("/")) read.add(i);
};
// A thread the binary carries as text: a compiled binary starts a thread from a program it holds, not from a file.
const carried = async (entry: string) => {
  const r = await Bun.build({ entrypoints: [join(root, entry)], target: "bun", minify: true, define, metafile: true });
  if (!r.success) fail(r);
  note(r);
  return r.outputs[0]!.text();
};
// The helper an ssh machine runs (src/fleet/sshlink.ts).
const handsJs = await carried("src/fleet/hands-main.ts");
// The read thread (src/server/reads.ts).
const readsJs = await carried("src/server/reads-worker.ts");
// The checkpoint thread (src/core/checkpoint.ts).
const checkpointJs = await carried("src/core/checkpoint-worker.ts");
// The worker a backup is made in (src/admin/backup-worker.ts).
const workerJs = await carried("src/admin/backup-worker.ts");
// The sandbox proxies' thread (src/safety/net-proxy.ts).
const netProxyJs = await carried("src/safety/net-proxy-worker.ts");
// The thread a search index made again is filled on (src/server/routes/search-fill.ts).
const searchFillJs = await carried("src/server/routes/search-fill-worker.ts");
// The thread a branch's pictures are compared on (src/pictures/run.ts).
const picturesJs = await carried("src/pictures/diff-worker.ts");
// The stall watcher's thread (src/admin/stall-watch.ts).
const stallWatchJs = await carried("src/admin/stall-watch-worker.ts");

// In the binary the daemon's import of ui/index.html is the page compiled
// above, not a second graph: a module that names each file (embedded as it
// is), the address it is served at, its type and a tag of its bytes, in the
// shape the daemon reads a page built ahead of time (bundleRoutes).
const embed = mkdtempSync(join(tmpdir(), "keel-embed-"));
const names = Object.keys(files).sort();
names.forEach((n, i) => writeFileSync(join(embed, `ui${i}.bin`), files[n]!));
const page = [
  ...names.map((_, i) => `import f${i} from ${JSON.stringify(join(embed, `ui${i}.bin`))};`),
  `export default { index: f${names.indexOf("index.html")}, files: [`,
  ...names.map((n, i) => `  { path: f${i}, route: ${JSON.stringify(`${UI_PREFIX}${n}`)}, headers: { "content-type": ${JSON.stringify(Bun.file(n).type)}, etag: ${JSON.stringify(Bun.hash(files[n]!).toString(36))} } },`),
  "] };",
].join("\n");
const embeddedPage: Bun.BunPlugin = {
  name: "keel-embedded-page",
  setup(b) {
    b.onResolve({ filter: /ui\/index\.html$/ }, () => ({ path: "page", namespace: "keel-page" }));
    b.onLoad({ filter: /.*/, namespace: "keel-page" }, () => ({ contents: page, loader: "js" }));
  },
};
let res: Bun.BuildOutput;
try {
  const t = performance.now();
  res = await Bun.build({
    entrypoints: [join(root, "src/main.ts")],
    // The binary reads nothing from the folder it starts in: a .env there could set KEEL_* or a provider's base URL,
    // and a bunfig.toml preload would run its code in the daemon.
    compile: { outfile: out, ...(target ? { target } : {}), autoloadDotenv: false, autoloadBunfig: false, autoloadTsconfig: false, autoloadPackageJson: false },
    // Names are kept: the daemon's own profile of its main thread (src/admin/stall-profile.ts) and its stack
    // traces name the functions they were in.
    minify: { whitespace: true, syntax: true, identifiers: false },
    splitting: true,
    sourcemap: "none",
    plugins: [embeddedPage],
    metafile: true,
    define: {
      ...define, __KEEL_API__: JSON.stringify(api), __KEEL_PAGE__: JSON.stringify(pageDigest(files)), __KEEL_UI_BUILT__: String(built), __KEEL_HANDS_JS__: JSON.stringify(handsJs), __KEEL_READS_JS__: JSON.stringify(readsJs),
      __KEEL_CHECKPOINT_JS__: JSON.stringify(checkpointJs), __KEEL_BACKUP_WORKER_JS__: JSON.stringify(workerJs), __KEEL_STALLWATCH_JS__: JSON.stringify(stallWatchJs), __KEEL_NETPROXY_JS__: JSON.stringify(netProxyJs), __KEEL_SEARCHFILL_JS__: JSON.stringify(searchFillJs), __KEEL_PICTURES_JS__: JSON.stringify(picturesJs),
      __KEEL_REVISION__: JSON.stringify(revision), __KEEL_SOURCE_DIR__: JSON.stringify(root), __KEEL_TARGET__: JSON.stringify((target ?? `bun-${process.platform}-${process.arch}`).replace(/^bun-/, "")),
    },
  });
  if (res.success) console.log(`binary: compiled in ${((performance.now() - t) / 1000).toFixed(2)}s`);
} finally {
  rmSync(embed, { recursive: true, force: true });
}
if (!res.success) fail(res);
note(res);
// The stamp hashes exactly what was compiled: a file the builds read that the graph misses (or the other way)
// would let a page bundle in over a daemon change. A new thread is named in BINARY_ENTRIES.
const missing = [...read].filter((f) => !graph.includes(f));
const extra = graph.filter((f) => !read.has(f));
if (missing.length || extra.length) {
  console.error(`the binary's import graph (src/core/api-stamp.ts) is not what its builds read: not in the graph ${missing.slice(0, 5).join(", ") || "none"}; not read ${extra.slice(0, 5).join(", ") || "none"}`);
  process.exit(1);
}
await pack(`${out}-ui.tar.gz`, files);
// What the landing install decides by (.keel/land-install.sh, scripts/install-kind.ts): the files the binary is
// compiled from, the build's own files, the stamp, the page's digest and the runtime the binary carries.
writeFileSync(`${out}.inputs.json`, JSON.stringify({ revision, api, page: pageDigest(files), bun: Bun.version, binary: graph, build: importGraph(root, ["scripts/build.ts"]) }, null, 1));
console.log(`built ${out} and ${out}-ui.tar.gz (revision ${revision}, api ${api}, UI ${built}) in ${((performance.now() - t0) / 1000).toFixed(2)}s`);
