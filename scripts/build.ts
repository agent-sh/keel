// One self-contained binary: daemon + bundled UI (Tailwind). The page is
// compiled once per run; the binary embeds its files and the UI bundle packs them.
//   bun scripts/build.ts [OUT [TARGET]]   the binary (default dist/keel), and OUT-ui.tar.gz beside it
//   bun scripts/build.ts --ui OUT.tar.gz  only the UI bundle, for `keel ui install OUT.tar.gz`
//                                         (a running daemon built from the same src/ serves it at once)
// It runs from any folder: the sources and the default dist/ are the repository's,
// and an OUT that is given is taken from where the command runs. The build itself
// runs in the repository, since the styles are made from the files found there.
import tailwind from "bun-plugin-tailwind";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
    const bytes = Object.values(files).reduce((n, f) => n + f.length, 0);
    console.log(`browser graph: ${Object.keys(files).length} files, ${(bytes / 1024).toFixed(0)} KB in ${((performance.now() - t) / 1000).toFixed(2)}s`);
    return files;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function pack(out: string, files: Record<string, Uint8Array>) {
  const manifest: UiManifest = { format: 1, version: built, api, files: Object.keys(files).sort() };
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
const hands = await Bun.build({ entrypoints: [join(root, "src/fleet/hands-main.ts")], target: "bun", minify: true, define });
if (!hands.success) fail(hands);
const handsJs = await hands.outputs[0]!.text();
// The read thread (src/server/reads.ts), carried as text the same way: a
// compiled binary starts a thread from a program it holds, not from a file.
const reads = await Bun.build({ entrypoints: [join(root, "src/server/reads-worker.ts")], target: "bun", minify: true, define });
if (!reads.success) fail(reads);
const readsJs = await reads.outputs[0]!.text();
// The checkpoint thread (src/core/checkpoint.ts), carried the same way.
const checkpoint = await Bun.build({ entrypoints: [join(root, "src/core/checkpoint-worker.ts")], target: "bun", minify: true, define });
if (!checkpoint.success) fail(checkpoint);
const checkpointJs = await checkpoint.outputs[0]!.text();
// The worker a backup is made in (src/admin/backup-worker.ts), carried the same way:
// a worker of the binary is started from text, whatever folder the daemon runs in.
const worker = await Bun.build({ entrypoints: [join(root, "src/admin/backup-worker.ts")], target: "bun", minify: true, define });
if (!worker.success) fail(worker);
const workerJs = await worker.outputs[0]!.text();
// The sandbox proxies' thread (src/safety/net-proxy.ts), carried the same way.
const netProxy = await Bun.build({ entrypoints: [join(root, "src/safety/net-proxy-worker.ts")], target: "bun", minify: true, define });
if (!netProxy.success) fail(netProxy);
const netProxyJs = await netProxy.outputs[0]!.text();
// The thread a search index made again is filled on (src/server/routes/search-fill.ts), carried the same way.
const searchFill = await Bun.build({ entrypoints: [join(root, "src/server/routes/search-fill-worker.ts")], target: "bun", minify: true, define });
if (!searchFill.success) fail(searchFill);
const searchFillJs = await searchFill.outputs[0]!.text();
// The stall watcher's thread (src/admin/stall-watch.ts), carried the same way.
const stallWatch = await Bun.build({ entrypoints: [join(root, "src/admin/stall-watch-worker.ts")], target: "bun", minify: true, define });
if (!stallWatch.success) fail(stallWatch);
const stallWatchJs = await stallWatch.outputs[0]!.text();

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
    compile: target ? { outfile: out, target } : { outfile: out },
    minify: true,
    splitting: true,
    sourcemap: "none",
    plugins: [embeddedPage],
    define: {
      ...define, __KEEL_API__: JSON.stringify(api), __KEEL_UI_BUILT__: String(built), __KEEL_HANDS_JS__: JSON.stringify(handsJs), __KEEL_READS_JS__: JSON.stringify(readsJs),
      __KEEL_CHECKPOINT_JS__: JSON.stringify(checkpointJs), __KEEL_BACKUP_WORKER_JS__: JSON.stringify(workerJs), __KEEL_STALLWATCH_JS__: JSON.stringify(stallWatchJs), __KEEL_NETPROXY_JS__: JSON.stringify(netProxyJs), __KEEL_SEARCHFILL_JS__: JSON.stringify(searchFillJs),
      __KEEL_REVISION__: JSON.stringify(revision), __KEEL_TARGET__: JSON.stringify((target ?? `bun-${process.platform}-${process.arch}`).replace(/^bun-/, "")),
    },
  });
  if (res.success) console.log(`binary: compiled in ${((performance.now() - t) / 1000).toFixed(2)}s`);
} finally {
  rmSync(embed, { recursive: true, force: true });
}
if (!res.success) fail(res);
await pack(`${out}-ui.tar.gz`, files);
console.log(`built ${out} and ${out}-ui.tar.gz (revision ${revision}, api ${api}, UI ${built}) in ${((performance.now() - t0) / 1000).toFixed(2)}s`);
