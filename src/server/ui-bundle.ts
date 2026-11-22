// The UI without a daemon restart. `bun scripts/build.ts --ui OUT` packs the
// page as a versioned bundle (a .tar.gz with manifest.json); `keel ui install
// OUT` sends it to the daemon (POST /api/ui), which checks it was built from
// the same daemon sources (`api`, a hash of src/), keeps it under
// <state>/ui/<version>/ with the one before it for `keel ui rollback` (as a
// transaction: see UiBundles), swaps the served page in place (server.reload: no socket and no turn is cut) and
// tells every open page over /ws (frame `ui`). A page reloads itself when the
// owner is not typing, else it offers the reload.
//
// The page embedded in the binary stays the fallback. At start the newer of
// the two is served: an installed bundle built after the binary, from the same
// sources, wins; one from other sources (the binary moved on) is passed over.
// Pages of every bundle still held keep their files: an open page that loads a
// chunk after a swap still finds it.
import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileRoute } from "./compress.ts";
import { daemonApi, sourceApi } from "../core/api-stamp.ts";

export { daemonApi, sourceApi };

declare const __KEEL_API__: string | undefined;
declare const __KEEL_UI_BUILT__: number | undefined;

export type UiManifest = { format: 1; version: number; api: string; files: string[] };
export const UI_PREFIX = "/_ui/";

// The page's version rides in its HTML, so a page always knows which one it loaded.
export function stamp(html: string, version: string): string {
  return html.replace(/<head>/i, `<head><meta name="keel-ui" content="${version}" />`);
}

const SAFE = /^(?!.*\.\.)[\w.-]+(\/[\w.-]+)*$/;

export function checkManifest(m: any, api: string, have: Set<string>): UiManifest {
  const bad = (why: string) => Object.assign(new Error(`not a UI bundle: ${why}`), { status: 400 });
  if (!m || m.format !== 1) throw bad("manifest.json is missing or of another format");
  if (!Number.isSafeInteger(m.version) || m.version <= 0) throw bad("no version");
  if (!Array.isArray(m.files) || !m.files.includes("index.html")) throw bad("no index.html");
  for (const f of m.files) {
    if (typeof f !== "string" || !SAFE.test(f) || f === "manifest.json") throw bad(`file name ${JSON.stringify(f)}`);
    if (!have.has(f)) throw bad(`${f} is listed but missing`);
  }
  if (m.api !== api) throw Object.assign(new Error(`this UI was built from other daemon sources (${m.api}, the daemon is ${api}): it needs a daemon restart onto a new binary`), { status: 409, code: "api_mismatch" });
  return { format: 1, version: m.version, api: m.api, files: m.files };
}

// A file written and synced, and a folder's entries synced (where the system syncs folders).
function writeSynced(path: string, bytes: Uint8Array) {
  const fd = openSync(path, "w");
  try {
    for (let at = 0; at < bytes.length; ) at += writeSync(fd, bytes, at);
    fsyncSync(fd);
  } finally { closeSync(fd); }
}
function syncDir(dir: string) {
  try { const fd = openSync(dir, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } } catch {}
}

type Held = { manifest: UiManifest; dir: string; page: (req: Request) => Response; files: Map<string, (req: Request) => Response> };
type Pointer = { current?: number; previous?: number };

// An install is a transaction. The bundle is written to a staging folder of
// its own and read back from there, the folder is renamed to its version, and
// then current.json is replaced (written beside, synced, renamed): that
// rename is the commit. What is served and what is kept change only after it.
// A failure at any step removes what the install wrote and leaves the page
// served before, and the one kept for rollback, as they were; so does a daemon
// that stops in the middle (the leftovers go at the next start).
// Installs run one at a time. A version is never rewritten: the same bundle
// again is a success that changes nothing (or serves it again when it was the
// one kept for rollback), and other files under a version already kept are
// refused (409, version_conflict).
export class UiBundles {
  private root: string;
  private held = new Map<number, Held>();
  private ptr: Pointer = {};
  private queue: Promise<unknown> = Promise.resolve();
  private staged = 0;
  // Which page is served now: an installed version, or the embedded one.
  active: { source: "installed" | "embedded"; version: string } = { source: "embedded", version: "dev" };

  constructor(stateDir: string, private api: string, readonly embedded: { version: string; built: number }, private onError: (e: Error) => void) {
    this.root = join(stateDir, "ui");
    mkdirSync(this.root, { recursive: true });
    try { this.ptr = JSON.parse(readFileSync(join(this.root, "current.json"), "utf8")); } catch {}
    for (const v of [this.ptr.current, this.ptr.previous]) {
      if (!v) continue;
      try { this.held.set(v, this.load(join(this.root, String(v)), v)); } catch (e) { this.onError(Object.assign(e as Error, { message: `UI bundle ${v}: ${(e as Error).message}` })); }
    }
    this.sweep();
    const cur = this.ptr.current ? this.held.get(this.ptr.current) : undefined;
    // At start the newer wins; one built from other sources never does.
    if (cur && cur.manifest.api === api && cur.manifest.version > embedded.built) this.active = { source: "installed", version: String(cur.manifest.version) };
    else this.active = { source: "embedded", version: embedded.version };
  }

  // A bundle read whole into memory from `dir`: what is served never reads the disk again.
  private load(dir: string, v: number): Held {
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as UiManifest;
    const files = new Map<string, (req: Request) => Response>();
    for (const f of manifest.files) if (f !== "index.html") files.set(f, fileRoute(join(dir, f), Bun.file(join(dir, f)).type, `${v}-${f}`, undefined, this.onError));
    const html = stamp(readFileSync(join(dir, "index.html"), "utf8"), String(v));
    const page = fileRoute(new TextEncoder().encode(html), "text/html;charset=utf-8", `${v}`, "no-cache", this.onError);
    return { manifest, dir: join(this.root, String(v)), page, files };
  }

  // Everything under ui/ the pointer does not name: bundles no longer kept and what a cut install left.
  private sweep() {
    const keep = new Set(["current.json", ...[this.ptr.current, this.ptr.previous].filter(Boolean).map(String)]);
    for (const d of readdirSync(this.root)) {
      if (keep.has(d)) continue;
      try { rmSync(join(this.root, d), { recursive: true, force: true }); } catch (e) { this.onError(Object.assign(e as Error, { message: `UI bundles: ${(e as Error).message}` })); }
    }
  }

  status() {
    const of = (v?: number) => (v && this.held.get(v) ? { version: v, api: this.held.get(v)!.manifest.api } : null);
    return { active: this.active, api: this.api, embedded: this.embedded, current: of(this.ptr.current), previous: of(this.ptr.previous) };
  }

  // The routes for the page: the active bundle's, else the embedded ones as given.
  routes(pages: string[], embedded: Record<string, any>): Record<string, any> {
    const out: Record<string, any> = { ...embedded };
    out[`${UI_PREFIX}*`] = (req: Request) => {
      const name = new URL(req.url).pathname.slice(UI_PREFIX.length);
      for (const h of this.held.values()) {
        const f = h.files.get(name);
        if (f) return f(req);
      }
      return new Response("not found", { status: 404 });
    };
    const cur = this.active.source === "installed" ? this.held.get(Number(this.active.version)) : undefined;
    if (cur) for (const p of pages) out[p] = cur.page;
    return out;
  }

  // One at a time, each after the one before it, whatever that one's outcome.
  install(bytes: Uint8Array): Promise<UiManifest> {
    const run = this.queue.then(() => this.installOne(bytes));
    this.queue = run.catch(() => {});
    return run;
  }

  private async installOne(bytes: Uint8Array): Promise<UiManifest> {
    let entries: Map<string, File>;
    try { entries = await new Bun.Archive(bytes).files(); } catch (e) { throw Object.assign(new Error(`not a UI bundle: ${(e as Error).message}`), { status: 400 }); }
    const mf = entries.get("manifest.json");
    let raw: unknown;
    try { raw = mf ? JSON.parse(await mf.text()) : undefined; } catch {}
    const m = checkManifest(raw, this.api, new Set(entries.keys()));
    const names = [...m.files, "manifest.json"];
    const data = new Map<string, Uint8Array>();
    for (const f of names) data.set(f, new Uint8Array(await entries.get(f)!.arrayBuffer()));
    const dir = join(this.root, String(m.version));
    const served = this.active.source === "installed" ? Number(this.active.version) : undefined;

    if (this.held.has(m.version)) {
      const same = (f: string) => { try { return Buffer.compare(readFileSync(join(dir, f)), data.get(f)!) === 0; } catch { return false; } };
      if (!names.every(same)) throw Object.assign(new Error(`UI bundle ${m.version} is already kept with other files: build the bundle again for a version of its own`), { status: 409, code: "version_conflict" });
      if (served !== m.version) this.point({ current: m.version, previous: served });
      return m;
    }

    const stage = join(this.root, `.stage-${process.pid}-${++this.staged}`);
    let moved = false;
    try {
      // Each file, then each folder, is on disk before the pointer names the bundle: after a
      // power cut the pointer never leads to a folder of empty files.
      const folders = new Set([stage]);
      for (const f of names) {
        mkdirSync(join(stage, f, ".."), { recursive: true });
        folders.add(join(stage, f, ".."));
        writeSynced(join(stage, f), data.get(f)!);
      }
      for (const d of folders) syncDir(d);
      const h = this.load(stage, m.version);
      rmSync(dir, { recursive: true, force: true }); // not kept (checked above): left by an install that was cut
      renameSync(stage, dir);
      syncDir(this.root);
      moved = true;
      this.held.set(m.version, h);
      this.point({ current: m.version, previous: served });
    } catch (e) {
      // The pointer was not replaced: nothing of this install stays.
      this.held.delete(m.version);
      rmSync(moved ? dir : stage, { recursive: true, force: true });
      throw e;
    }
    return m;
  }

  // Drops the served bundle: back to the one before, or to the embedded page when none is kept.
  rollback(): void {
    const prev = this.ptr.previous;
    this.point(prev && this.held.get(prev) ? { current: prev } : {});
  }

  // The commit: current.json replaced in one rename, then what is served and kept follows it.
  private point(p: Pointer) {
    const f = join(this.root, "current.json");
    const fd = openSync(`${f}.part`, "w");
    try { writeSync(fd, JSON.stringify(p)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(`${f}.part`, f);
    syncDir(this.root);
    this.ptr = p;
    this.active = p.current ? { source: "installed", version: String(p.current) } : { source: "embedded", version: this.embedded.version };
    // Two kept: what is served and the one before it.
    const keep = new Set([p.current, p.previous].filter(Boolean).map(String));
    for (const v of [...this.held.keys()]) if (!keep.has(String(v))) this.held.delete(v);
    this.sweep();
  }
}

export const embeddedBuilt = () => (typeof __KEEL_UI_BUILT__ === "number" ? __KEEL_UI_BUILT__ : 0);
