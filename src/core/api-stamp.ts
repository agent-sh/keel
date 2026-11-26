// Which daemon sources this process was built from: what a UI bundle is
// checked against (src/server/ui-bundle.ts) and what `keel --version` says.
// Kept apart from the bundle's code so the version line loads nothing else.
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

declare const __KEEL_API__: string | undefined;

// The programs the binary is compiled from: the daemon and the threads it carries as text. scripts/build.ts
// builds each of these and fails when what its builds read is not their graph below.
export const BINARY_ENTRIES = [
  "src/main.ts",
  "src/fleet/hands-main.ts",
  "src/server/reads-worker.ts",
  "src/core/checkpoint-worker.ts",
  "src/admin/backup-worker.ts",
  "src/safety/net-proxy-worker.ts",
  "src/server/routes/search-fill-worker.ts",
  "src/pictures/diff-worker.ts",
  "src/admin/stall-watch-worker.ts",
];

const CODE = /\.[cm]?[jt]sx?$/;
const transpilers = { ts: new Bun.Transpiler({ loader: "ts" }), tsx: new Bun.Transpiler({ loader: "tsx" }) };

// Every file of the repository a program imports, followed from its entries as the bundler resolves them
// (type-only imports are dropped, as the build drops them), as sorted paths from the root. Packages and the
// runtime's own modules are not followed, and neither is the page (ui/index.html), which is built apart.
export function importGraph(root: string, entries: string[]): string[] {
  const seen = new Set<string>();
  const stack = entries.map((e) => resolve(root, e));
  while (stack.length) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    if (!CODE.test(file)) continue;
    const t = file.endsWith("x") ? transpilers.tsx : transpilers.ts;
    for (const im of t.scanImports(readFileSync(file, "utf8").replace(/^#!.*/, ""))) {
      if (!/^\.{0,2}\//.test(im.path) || /(^|\/)ui\/index\.html$/.test(im.path)) continue;
      const to = Bun.resolveSync(im.path, dirname(file));
      if (!to.includes("/node_modules/")) stack.push(to);
    }
  }
  return [...seen].map((f) => relative(root, f)).filter((f) => !f.startsWith("..")).sort();
}

export const binaryGraph = (root: string) => importGraph(root, BINARY_ENTRIES);

// The daemon side of the contract: the files the binary is compiled from, its import graph (no test, no doc, no
// module only the page or a script imports). A UI change that needs a daemon change cannot be installed without
// a restart.
export function sourceApi(root: string, files = binaryGraph(root)): string {
  const h = new Bun.CryptoHasher("sha256");
  for (const f of files) h.update(f + "\0").update(readFileSync(resolve(root, f))).update("\0");
  return h.digest("hex").slice(0, 16);
}

// What this daemon was built from: stamped in by scripts/build.ts, read from the sources when run from them.
export const daemonApi = () => (typeof __KEEL_API__ === "string" ? __KEEL_API__ : sourceApi(resolve(import.meta.dir, "../..")));

// A page by its bytes: the digest of its files, names and contents, with the hash each output name carries
// (chunk-<hash>.js) left out wherever it stands. The bundler's chunk hashes also hash where the build's packages
// lie relative to its folder, so the same page built in another folder takes other names; its contents are the
// same. Two builds of one page give one digest, whatever their time, folder or commit, so a landing can tell
// whether the page it built is the one served.
const NAMED = /-([a-z0-9]{8})\.[a-z0-9]+$/;
const TEXT = /\.(html|js|css|json|svg|txt|webmanifest)$/;
export function pageDigest(files: Record<string, Uint8Array>): string {
  const tags = Object.keys(files).map((n) => n.match(NAMED)?.[1]).filter((t): t is string => !!t);
  const tag = tags.length ? new RegExp(tags.join("|"), "g") : undefined;
  const plain = (s: string) => (tag ? s.replace(tag, "*") : s);
  // Many names are the same once their hashes are out: each file is its name and its contents' own digest, sorted.
  const one = (body: string | Uint8Array) => new Bun.CryptoHasher("sha256").update(body).digest("hex");
  const entries = Object.entries(files).map(([name, bytes]) => `${plain(name)}\0${one(TEXT.test(name) ? plain(new TextDecoder().decode(bytes)) : bytes)}`).sort();
  const h = new Bun.CryptoHasher("sha256");
  for (const e of entries) h.update(e + "\n");
  return h.digest("hex").slice(0, 16);
}
