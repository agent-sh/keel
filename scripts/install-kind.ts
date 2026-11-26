// Which install a landed commit needs over the daemon that runs (.keel/land-install.sh): none, the page alone,
// or the engine (a new binary and a restart). It runs from the install's own folder, so it imports nothing.
//
//   bun install-kind.ts DIR REPO URL     prints {"kind":..., "why":...}: DIR holds the build (commit,
//                                        keel.inputs.json), REPO the git history, URL the daemon
//
// The engine is the same when the files the binary is compiled from hash the same (the build's api stamp
// against the daemon's), the binary was built with the runtime the daemon runs on (a Bun upgrade changes no file of
// the repository), and the change touches none of the build's own files or the toolchain's at the root.
// The page is the same when the built page's digest is the one served. Whatever cannot be compared (a daemon
// of no known commit, a history without it, a daemon that does not say) is the engine: a restart, as before.

export type Kind = "none" | "page" | "engine";
export type Facts = {
  // The landed commit.
  target: string;
  // The daemon: its engine's revision and sources stamp, and the page it serves (by digest and commit).
  engine: { revision: string | null; api: string | null; bun: string | null };
  served: { page: string | null; revision: string | null };
  // The build of the target: its stamp, its page's digest, the files the binary and the build read.
  built: { api: string; page: string; binary: string[]; build: string[]; bun: string | null };
  // The files that differ between the engine's revision and the target; null when git could not say.
  changed: string[] | null;
  // The engine runs a later commit than the target; the page served is from a later commit than the target.
  engineLater: boolean;
  pageLater: boolean;
};

const COMMIT = /^[0-9a-f]{40}$/;
// A file at the root that is not a doc is the toolchain's (the package, its lock, bunfig, tsconfig): it can change
// the binary without being imported.
const DOC = /(\.(md|txt)|^LICENSE[^/]*)$/i;
const toolchain = (f: string) => !f.includes("/") && !DOC.test(f);
const some = (fs: string[]) => fs.slice(0, 4).join(", ") + (fs.length > 4 ? ` and ${fs.length - 4} more` : "");

export function installKind(f: Facts): { kind: Kind; why: string } {
  const { engine, served, built } = f;
  if (!engine.revision || !COMMIT.test(engine.revision)) return { kind: "engine", why: `the daemon runs no known commit (${engine.revision ?? "none"}): it is replaced` };
  if (f.engineLater) return { kind: "none", why: `the daemon already runs ${engine.revision.slice(0, 12)}, a later commit: nothing installed` };
  if (!built.bun || engine.bun !== built.bun) return { kind: "engine", why: `the build ran on Bun ${built.bun ?? "unknown"}, the daemon on Bun ${engine.bun ?? "unknown"}: the engine is replaced` };
  if (engine.revision !== f.target) {
    if (f.changed === null) return { kind: "engine", why: `what changed since ${engine.revision.slice(0, 12)} could not be read: the engine is replaced` };
    const build = new Set(built.build);
    const binary = new Set(built.binary);
    const touched = f.changed.filter((p) => binary.has(p) || build.has(p) || toolchain(p));
    if (touched.length) return { kind: "engine", why: `the engine changed (${some(touched)})` };
  }
  if (engine.api !== built.api) return { kind: "engine", why: `the daemon's sources stamp (${engine.api ?? "none"}) is not the build's (${built.api})` };
  const files = f.changed?.length ? ` (${f.changed.length} file${f.changed.length === 1 ? "" : "s"} changed, none the binary is built from)` : "";
  if (served.page === built.page) return { kind: "none", why: `nothing the binary or the page uses changed${files}: nothing installed` };
  if (f.pageLater) return { kind: "none", why: `the page served is from ${served.revision!.slice(0, 12)}, a later commit: nothing installed` };
  return { kind: "page", why: `only the page changed${files}: it is installed with no restart` };
}

if (import.meta.main) {
  const [dir, repo, url] = process.argv.slice(2);
  if (!dir || !repo || !url) {
    console.error("bun install-kind.ts DIR REPO URL");
    process.exit(2);
  }
  const target = (await Bun.file(`${dir}/commit`).text()).trim();
  const inputs = JSON.parse(await Bun.file(`${dir}/keel.inputs.json`).text());
  const get = async (path: string) => {
    const r = await fetch(url + path, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error(`${path}: ${r.status}`);
    return (await r.json()) as any;
  };
  const daemon = await get("/api/daemon");
  const ui = await get("/api/ui");
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "ignore" });
    return { ok: r.exitCode === 0, out: r.stdout.toString() };
  };
  const revision = typeof daemon.build?.revision === "string" ? daemon.build.revision : null;
  // A later commit: the target is its ancestor (and not it).
  const later = (r: unknown) => typeof r === "string" && COMMIT.test(r) && r !== target && git("merge-base", "--is-ancestor", target, r).ok;
  let changed: string[] | null = null;
  if (revision && COMMIT.test(revision)) {
    const d = git("diff", "--name-only", "--no-renames", revision, target);
    if (d.ok) changed = d.out.split("\n").filter(Boolean);
  }
  const facts: Facts = {
    target,
    engine: { revision, api: typeof ui.api === "string" ? ui.api : null, bun: typeof daemon.bun === "string" ? daemon.bun : null },
    served: { page: typeof ui.active?.page === "string" ? ui.active.page : null, revision: typeof ui.active?.revision === "string" ? ui.active.revision : null },
    built: { api: inputs.api, page: inputs.page, binary: inputs.binary, build: inputs.build, bun: typeof inputs.bun === "string" ? inputs.bun : null },
    changed,
    engineLater: later(revision),
    pageLater: later(ui.active?.revision),
  };
  process.stdout.write(JSON.stringify(installKind(facts)) + "\n");
}
