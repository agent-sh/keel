// What a confined command can read, and what a sandboxed session's file
// tools read without the owner: one rule for both (shownTo).
//
// A sandboxed command runs without a card in three modes, so what it can read
// it can also send away. The view is an allow list:
//
// - The system is readable as it is (/usr, /etc, /opt, ...): unix permissions
//   guard what is secret there.
// - Every other folder at the top of the file system is hidden: the home
//   folders, /root, /mnt, /media, a data disk. So are /run (with the session
//   bus, the keyring, the agents, the display and the Docker socket: a unix
//   socket in a read-only bind still takes connections) and the folders of
//   /var that hold what programs leave behind.
// - The home is an empty folder in memory, read-only once the view is built:
//   a write outside the session's folder fails, as it always did. In it:
//   * read-only, from the real home: the toolchains (a table of well-known
//     names, the roots the toolchain variables name, the folders of the
//     daemon's PATH with the toolchain around them, and what the links in
//     those folders point at), a few plain settings a build needs (git's
//     global config, version files, the registry lines of the package
//     managers' settings without their tokens), and what the owner added;
//   * writable, the sandbox's own (one set per repository, on disk in
//     Keel's state): the XDG cache and state folders, which the sandbox
//     names (`~/.keel-sandbox`, not `~/.cache`: that is where people keep
//     work, and a write there must fail and not land in a copy nobody sees);
//   * the package caches (CACHES, XDG_CACHES), copy-on-write: a command
//     reads the owner's real cache, and what it writes lands in a layer of
//     the sandbox's own that nothing outside reads. A real cache bound
//     read-only breaks installs (measured), and bound writable it lets a
//     confined command plant what a later build runs outside. The kernel
//     does not allow two mounts over one writable layer, so a repository
//     has several (slots): the command's wrapper takes the first free one
//     under a lock it holds while the command runs (src/safety/sandbox.ts).
// - Nothing inside a credential store or one of Keel's own folders is bound,
//   whatever names it (a link in a PATH folder, a toolchain variable, git's
//   config): only the owner's list opens a store, by naming it. After every
//   other bind the stores and Keel's folders are hidden inside whatever was
//   bound (masks), always. What Keel itself gives a session from its own
//   folders (its skills, the session's attachments and artifacts, a worktree
//   Keel made) is bound after that.
// - Nothing is followed from a folder the sandbox can write: a PATH folder
//   or a toolchain root inside the workspace is the workspace's, and a link
//   there points where a command made it point.
//
// Research: ~/.cache/keel-work/bun/research/sandbox-network-and-secrets.md.
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { gitSync, gitViewsDir, locate } from "../core/git.ts";
import { contains, realOf } from "../core/paths.ts";
import { readText } from "../core/proc.ts";
import { configDir } from "../providers/config.ts";
import { sandboxRoot, sandboxScope, SCOPE_ORIGIN, scopeDir } from "./sandbox-scope.ts";

export { sandboxRoot, sandboxScope };

// What the owner set for a workspace (src/safety/sandbox-config.ts), and what Keel adds for the session.
export type ReadOpts = {
  // More folders and files a command may read, absolute or under ~.
  read?: string[];
  // The SSH agent's socket: a command can use the keys, not read them.
  sshAgent?: boolean;
  // Folders in Keel's own state that are the session's: the files it was given, its outputs, its artifacts. Shown read-only.
  own?: string[];
  // More names of environment variables a command keeps (envDropped).
  env?: string[];
  // The folder the session was made in, as the gate pinned it (device and inode): a sandboxed command checks the
  // folder it was given against it before it runs (sandbox.ts compose).
  root?: string;
  // The worktrees Keel made that this session may read: its own agents'. Another session's worktree of the same
  // repository, in Keel's state, is not one of the repository's checkouts to this session.
  worktrees?: string[];
  // What an agent's write scope keeps read-only in a workspace-write profile (src/safety/write-scope.ts): the
  // session's folder, when no place of the scope holds it, and the ref files of branches other checkouts have out.
  held?: { workspace?: true; refs?: string[] };
};

// The folders at the top of a Linux file system that hold the system.
const SYSTEM = new Set(["usr", "bin", "sbin", "lib", "lib32", "lib64", "libx32", "etc", "opt", "nix", "gnu", "snap", "var", "sys", "proc", "dev", "run", "tmp", "boot"]);
// Of those, what a sandbox gets as its own and not the machine's: a file tool does not read the machine's there.
const SYSTEM_OWN = ["/run", "/tmp", "/proc", "/dev"];
// In /var: what programs and people leave behind.
const VAR_HIDDEN = ["tmp", "log", "mail", "spool", "backups", "crash"];
// In /run, what stays: the system's own program folders on distributions
// that keep them there, and the journal's intake (a login shell's profile
// scripts log through it; it takes lines and gives nothing back).
const RUN_KEPT = ["/run/current-system", "/run/opengl-driver", "/run/wrappers", "/run/host", "/run/systemd/journal/stdout", "/run/systemd/journal/socket"];

// Toolchains in a home, by their well-known names: the parts that hold
// programs and runtimes, not their caches (those are layered, below).
const TOOLCHAINS = [
  ".local/bin", ".local/lib", ".local/share/uv", ".local/share/pipx", ".local/pipx", ".local/share/mise", ".local/share/fnm",
  ".cargo/bin", ".cargo/config.toml", ".cargo/config", ".cargo/env", ".rustup",
  ".bun/bin", ".bun/install/global", ".nvm", ".volta", ".fnm", ".asdf", ".pyenv", ".rbenv", ".nodenv", ".goenv", ".jenv",
  ".sdkman/candidates", ".sdkman/bin", ".deno/bin", ".dotnet", ".ghcup/bin", ".ghcup/ghc", ".cabal/bin", ".stack/programs", ".opam",
  ".mix/escripts", ".mix/archives", ".juliaup", ".elan", ".nimble/bin", ".choosenim", ".luarocks", ".gem/ruby", ".gem/bin",
  ".composer/vendor", ".config/composer/vendor", ".pub-cache/bin", ".krew/bin", ".linuxbrew", ".nix-profile", ".nix-defexpr", ".local/state/nix/profiles",
  ".conda/envs", "miniconda3", "anaconda3", "miniforge3", "mambaforge", "micromamba", ".virtualenvs", ".jdks", ".gradle/wrapper", ".gradle/jdks",
  "Android/Sdk", "go/bin", ".yarn/bin", ".config/yarn/global", ".npm-global", ".terminfo",
];
// Plain settings a build reads: none of them holds a credential by its purpose.
const SETTINGS = [
  ".gitconfig", ".config/git/config", ".config/git/ignore", ".config/git/attributes", ".editorconfig",
  ".tool-versions", ".asdfrc", ".python-version", ".node-version", ".nvmrc", ".ruby-version", ".mise.toml", ".config/mise/config.toml", ".config/go/env",
];
// Variables that name a toolchain's folder (some hold a list).
const ROOT_VARS = [
  "CARGO_HOME", "RUSTUP_HOME", "GOROOT", "NVM_DIR", "BUN_INSTALL", "PNPM_HOME", "PYENV_ROOT", "RBENV_ROOT", "ASDF_DIR", "ASDF_DATA_DIR", "MISE_DATA_DIR",
  "VOLTA_HOME", "DENO_INSTALL", "JAVA_HOME", "ANDROID_HOME", "ANDROID_SDK_ROOT", "VIRTUAL_ENV", "CONDA_PREFIX", "UV_TOOL_DIR", "UV_PYTHON_INSTALL_DIR",
  "PIPX_HOME", "GEM_HOME", "DOTNET_ROOT", "SDKMAN_DIR", "FLUTTER_ROOT", "GHCUP_INSTALL_BASE_PREFIX", "NIX_PROFILES",
];
// In a toolchain root: what is its cache, or its credentials. Never bound with it.
const ROOT_SKIPPED: Record<string, string[]> = { CARGO_HOME: ["registry", "git", "credentials.toml", "credentials"], BUN_INSTALL: ["install/cache"], PNPM_HOME: ["store"], GEM_HOME: ["credentials"] };

// Where package managers and build tools keep what they fetch and build, by
// their default paths in a home. Only the part that is a cache: the folder
// above it often holds the tool's credentials (~/.cargo, ~/.m2, ~/.gradle).
export const CACHES = [
  ".npm/_cacache", ".npm/_npx", ".bun/install/cache", ".cargo/registry", ".cargo/git", "go/pkg", ".local/share/pnpm", ".gradle/caches", ".gradle/native",
  ".m2/repository", ".nuget/packages", ".pub-cache/hosted", ".hex/packages", ".cabal/packages", ".cabal/store", ".stack/snapshots", ".stack/pantry",
  ".julia/packages", ".julia/artifacts", ".julia/registries", ".julia/compiled", ".conda/pkgs", ".deno", ".yarn/berry", ".bundle/cache", ".ccache",
];
// The folder a tool keeps all its own files in, cache included. Where the
// owner has none yet (a first use of the tool), the sandbox gives the whole
// folder as its own: the tool writes locks and indexes beside its cache.
// Only for a tool that is installed (its program is on PATH).
const TOOL_ROOT = (rel: string) => (rel.startsWith(".local/share/") ? rel : rel.split("/")[0]!);
const TOOL_OF: Record<string, string[]> = {
  ".npm": ["npm"], ".bun": ["bun"], ".cargo": ["cargo"], go: ["go"], ".local/share/pnpm": ["pnpm"], ".gradle": ["gradle"], ".m2": ["mvn"], ".nuget": ["dotnet"],
  ".pub-cache": ["dart", "flutter"], ".hex": ["mix"], ".cabal": ["cabal"], ".stack": ["stack"], ".julia": ["julia"], ".conda": ["conda", "mamba"], ".deno": ["deno"],
  ".yarn": ["yarn"], ".bundle": ["bundle"], ".ccache": ["ccache"],
};
let installedKept: { path: string; at: number; roots: Set<string> } | undefined;
function installedRoots(env: Record<string, string | undefined>): Set<string> {
  const path = env.PATH ?? "";
  if (installedKept && installedKept.path === path && Date.now() - installedKept.at < 30_000) return installedKept.roots;
  const roots = new Set(Object.entries(TOOL_OF).filter(([, names]) => names.some((n) => Bun.which(n, { PATH: path }))).map(([root]) => root));
  installedKept = { path, at: Date.now(), roots };
  return roots;
}
// The same under the XDG cache folder (~/.cache), by name.
export const XDG_CACHES = [
  "uv", "pip", "go-build", "ms-playwright", "pnpm", "yarn", "deno", "zig", "sccache", "ccache", "pre-commit", "pypoetry", "pdm", "node-gyp", "node", "Cypress", "puppeteer",
  "electron", "huggingface/hub", "huggingface/datasets", "bazel", "bazelisk", "golangci-lint", "turbo",
];
// Folders of the sandbox's own with nothing of the owner's under them: where tools keep logs and locks.
const PRIVATE = [".npm", ".gradle/daemon", ".local/share/NuGet"];
// The sandbox's own writable folder in its home: the XDG cache and state folders are in it.
const RW = ".keel-sandbox";
const XDG: [string, string][] = [["XDG_CACHE_HOME", "cache"], ["XDG_STATE_HOME", "state"]];
// The slot's place in a layer's path: the command's wrapper puts the number of the slot it took there.
export const SLOT = "@KEEL_SLOT@";

// The well-known credential stores of a home, and what holds the owner's
// history or runs at login. Nothing in one is bound unless the owner's list
// names the store; inside whatever else is bound they are hidden. No list
// of these is complete, which is why the home is not readable to begin with.
export const CREDENTIALS = [
  ".ssh", ".aws", ".azure", ".gnupg", ".netrc", ".npmrc", ".yarnrc.yml", ".pypirc", ".git-credentials", ".config/git/credentials", ".docker", ".kube", ".minikube",
  ".password-store", ".local/share/keyrings", ".config/gh", ".config/hub", ".config/glab-cli", ".config/gcloud", ".config/op", ".config/1Password", ".config/rclone",
  ".config/doctl", ".config/hcloud", ".config/helm", ".config/nebius", ".config/configstore", ".config/github-copilot", ".config/sops", ".vault-token", ".terraform.d", ".oci", ".fly", ".wrangler",
  ".cloudflared", ".mozilla", ".thunderbird", ".config/google-chrome", ".config/chromium", ".config/BraveSoftware", ".config/microsoft-edge", "snap/firefox", "snap/chromium",
  ".bash_history", ".zsh_history", ".python_history", ".node_repl_history", ".psql_history", ".mysql_history", ".lesshst", ".viminfo",
  ".claude", ".claude.json", ".codex", ".gemini", ".cursor", ".grok", ".kimi", ".kimi-code", ".opencode", ".config/opencode", ".local/share/opencode", ".hermes", ".aider.conf.yml",
  ".cargo/credentials.toml", ".cargo/credentials", ".gem/credentials", ".pub-cache/credentials.json",
  ".m2/settings.xml", ".m2/settings-security.xml", ".gradle/gradle.properties", ".composer/auth.json", ".config/composer/auth.json", ".hex/hex.config",
  ".bashrc", ".bash_profile", ".bash_login", ".profile", ".zshrc", ".zshenv", ".zprofile", ".zlogin", ".config/fish",
  ".pgpass", ".my.cnf", ".config/environment.d", ".config/systemd/user", ".config/containers", ".config/pypoetry", ".config/pnpm", ".config/pip", ".pip", ".local/share/fish",
  ".local/share/atuin", ".cache/huggingface/token", ".cache/huggingface/stored_tokens", ".boto", ".s3cfg", ".bunfig.toml", ".Xauthority", ".config/uv", ".gemrc",
  ".config/Code", ".config/Cursor", ".config/zed", ".vscode", ".vscode-server", ".local/share/zed", ".config/JetBrains", ".local/share/JetBrains",
];

// (Where a path is, as the kernel walks it: src/core/paths.ts. Never by its text.)
const real = (p: string) => realOf(p);
// The owner's home as their programs know it: HOME, which a command inherits.
export const ownerHome = () => real(process.env.HOME && isAbsolute(process.env.HOME) ? process.env.HOME : homedir());
const kind = (p: string): "dir" | "file" | "link" | "other" | "none" => {
  try {
    const st = lstatSync(p);
    return st.isSymbolicLink() ? "link" : st.isDirectory() ? "dir" : st.isFile() ? "file" : "other";
  } catch {
    return "none";
  }
};
const isDir = (p: string) => { try { return statSync(p).isDirectory(); } catch { return false; } };
const under = (root: string, p: string) => p !== root && contains(root, p);
// Whether the view hides a path unless it is bound: in the home, or under a
// folder at the top of the file system that is not the system's (another
// home, a data disk: /home/linuxbrew, /mnt/tools).
const hiddenPlace = (p: string, home: string) => contains(home, p) || (isAbsolute(p) && p !== "/" && !SYSTEM.has(p.split("/")[1]!));
const tilde = (p: string, home: string) => (p === home ? "~" : contains(home, p) ? `~/${p.slice(home.length + 1)}` : p);

// ---- the stores ----

// Keel's own folders: the state (every session's text, the API token, device keys) and the config.
export const ownFolders = () => [real(dirname(gitViewsDir())), real(configDir())];
// The credential store or folder of Keel's own that a path (as it lands, links resolved) is in.
export function storeOf(p: string, home = ownerHome()): { path: string; own: boolean } | undefined {
  for (const dir of ownFolders()) if (contains(dir, p)) return { path: dir, own: true };
  for (const rel of CREDENTIALS) { const s = join(home, rel); if (contains(s, p)) return { path: s, own: false }; }
  return undefined;
}

// ---- the sandbox's own folders ----

// Under Keel's state folder, one per repository: what it writes in its home, its temp folder, its cache layers.
export function sandboxHome(scope: string): { dir: string; rw: string; tmp: string } {
  const dir = scopeDir(scope);
  const rw = join(dir, "rw"), tmp = join(dir, "tmp");
  if (!isDir(rw) || !isDir(tmp)) for (const d of [rw, tmp, join(dir, "slots")]) mkdirSync(d, { recursive: true, mode: 0o700 });
  return { dir, rw, tmp };
}

// ---- the cache layers ----

// Whether this machine mounts an overlay inside the sandbox, with a layer in
// Keel's state folder: asked once. (Unprivileged overlay mounts need a
// kernel from 5.11 and bubblewrap from 0.11, and not every file system can
// be a layer.) Without it the caches are the sandbox's own folders, empty
// at first.
let overlayOk: boolean | undefined;
// (The kernel leaves a folder with no permissions in an overlay's work folder: opened up, then removed. No program is run for it.)
function removeProbe(probe: string) {
  try { chmodSync(join(probe, "work", "work"), 0o700); } catch {} // none was made
  try { rmSync(probe, { recursive: true, force: true }); } catch {} // left for the next start
}
const probeArgv = (bwrap: string, probe: string) =>
  [bwrap, "--ro-bind", "/", "/", "--tmpfs", "/tmp", "--overlay-src", join(probe, "low"), "--overlay", join(probe, "up"), join(probe, "work"), "/tmp/o", "--", "/bin/true"];
export function overlays(bwrap: string | null = Bun.which("bwrap")): boolean {
  if (overlayOk !== undefined) return overlayOk;
  // (No answer is kept from a moment that could not ask: no program found, or a probe that did not end.)
  if (!bwrap) return false;
  const probe = join(sandboxRoot(), `probe-${process.pid}`);
  let answer = false;
  try {
    for (const d of ["low", "up", "work"]) mkdirSync(join(probe, d), { recursive: true, mode: 0o700 });
    const r = Bun.spawnSync(probeArgv(bwrap, probe), { stdout: "ignore", stderr: "ignore", timeout: 10_000 });
    answer = r.exitCode === 0;
    if (r.exitCode !== null) overlayOk = answer;
  } catch {} // the probe's folders could not be made now: asked again at the next command
  removeProbe(probe);
  return answer;
}
// The same question asked ahead, off the loop: a daemon asks at its start,
// so its first sandboxed command does not wait for a program to run.
export async function warmOverlays(bwrap: string | undefined): Promise<void> {
  if (overlayOk !== undefined || !bwrap) return;
  const probe = join(sandboxRoot(), `probe-warm-${process.pid}`);
  try {
    for (const d of ["low", "up", "work"]) mkdirSync(join(probe, d), { recursive: true, mode: 0o700 });
    const p = Bun.spawn(probeArgv(bwrap, probe), { stdout: "ignore", stderr: "ignore" });
    const timer = setTimeout(() => p.kill(), 20_000);
    const code = await p.exited;
    clearTimeout(timer);
    if (overlayOk === undefined && !p.signalCode) overlayOk = code === 0;
  } catch {} // asked again by the first command
  removeProbe(probe);
}
// The program that takes a file lock for a command (util-linux): the wrapper holds a layer by it.
let flockAt: string | null | undefined;
export const flockPath = () => (flockAt ??= Bun.which("flock") ?? (["/usr/bin/flock", "/bin/flock"].find((p) => existsSync(p)) || null));

// ---- tending ----

// Removing what a sandbox held. A sandboxed command writes these folders,
// so nothing in them is believed: an entry may be a link to anywhere, and
// may become one while it is being removed. So an entry is first moved, by
// its name (a rename follows no link), into a folder no sandbox is given
// (`trash`, on the same file system), and removed there: a link is
// unlinked, a folder is made writable through (a module cache keeps its
// folders read-only; chmod -R follows no link below the folder it is given,
// and that folder is no link by then) and removed without leaving its file
// system. A path that is not inside Keel's sandbox folder is not touched.
const REMOVE = 'for d in "$@"; do if [ -L "$d" ] || [ ! -d "$d" ]; then rm -f -- "$d"; else chmod -R u+rwX -- "$d" 2>/dev/null; rm -rf --one-file-system -- "$d"; fi; done';
function toTrash(paths: string[]): string[] {
  const root = sandboxRoot(), trash = join(root, "trash");
  const out: string[] = [];
  for (const p of paths) {
    // (Its folder is one of Keel's own, with no link in its path: only the entry's own name can be anything.)
    const dir = dirname(p);
    if (!contains(root, dir) || dir === trash || real(dir) !== dir) continue;
    try {
      mkdirSync(trash, { recursive: true, mode: 0o700 });
      const to = join(trash, crypto.randomUUID());
      renameSync(p, to);
      out.push(to);
    } catch {} // gone already, or held: left for the next round
  }
  return out;
}
// A sandbox's temp files are kept as long as systemd keeps /tmp's by
// default (tmpfiles.d, 10 days), and a cache layer no command used as long
// as it keeps /var/tmp's (30 days): a layer is a cache, fetched again when
// it is missed.
const TMP_KEEP_MS = 10 * 86_400_000;
const LAYER_KEEP_MS = 30 * 86_400_000;
// What the sandboxes hold on disk, tended (at a daemon's start and daily),
// off the loop: the folders of repositories that are gone, temp files and
// layers past their age. `all`: every layer and temp file no command holds
// (the owner's "clear"). A layer in use is held by its lock and left.
export async function tendSandboxes(all = false): Promise<void> {
  let names: string[] = [];
  try { names = readdirSync(sandboxRoot()); } catch {} // none made yet
  const flock = flockPath();
  const run = async (argv: string[]) => { try { await Bun.spawn(argv, { stdout: "ignore", stderr: "ignore" }).exited; } catch {} }; // left for the next round
  const remove = async (paths: string[]) => { const moved = toTrash(paths); if (moved.length) await run(["sh", "-c", REMOVE, "sh", ...moved]); };
  const now = Date.now();
  // What an earlier round moved and did not finish.
  try { const left = readdirSync(join(sandboxRoot(), "trash")).map((n) => join(sandboxRoot(), "trash", n)); if (left.length) await run(["sh", "-c", REMOVE, "sh", ...left]); } catch {} // no trash
  for (const name of names) {
    const dir = join(sandboxRoot(), name);
    if (name === "trash") continue;
    if (name.startsWith("probe")) { removeProbe(dir); continue; }
    let origin: string | undefined;
    try { origin = readFileSync(join(dir, SCOPE_ORIGIN), "utf8"); } catch {} // not a scope's folder (the relay, the settings)
    if (origin === undefined) continue;
    if (!existsSync(origin)) { await remove([dir]); continue; }
    // Temp files: by age, each entry at the top.
    let tmp: string[] = [];
    try { tmp = readdirSync(join(dir, "tmp")); } catch {} // none
    const old: string[] = [];
    for (const t of tmp) {
      let at = 0;
      try { at = lstatSync(join(dir, "tmp", t)).mtimeMs; } catch { continue; }
      if (all || now - at > TMP_KEEP_MS) old.push(join(dir, "tmp", t));
    }
    for (let i = 0; i < old.length; i += 64) await remove(old.slice(i, i + 64));
    // Layers: by the time a command last took the slot, under the slot's own lock. The lock is taken by a helper
    // that holds it while the layer's folders are moved away (a command that starts then waits, and makes them anew).
    let slots: string[] = [];
    try { slots = readdirSync(join(dir, "slots")).filter((f) => /^\d+\.lock$/.test(f)); } catch {} // none
    for (const f of slots) {
      const slot = f.slice(0, -5), lock = join(dir, "slots", f);
      let at = 0;
      try { at = statSync(lock).mtimeMs; } catch { continue; }
      if (!flock || !(all || now - at > LAYER_KEEP_MS)) continue;
      const up = join(dir, "up", slot), work = join(dir, "work", slot);
      if (real(dirname(up)) !== dirname(up) || real(dirname(work)) !== dirname(work)) continue;
      const trash = join(sandboxRoot(), "trash");
      mkdirSync(trash, { recursive: true, mode: 0o700 });
      const to = join(trash, crypto.randomUUID());
      // (mv by name inside the lock: a rename, which follows no link.)
      await run([flock, "-n", lock, "sh", "-c", 'mkdir "$0" && { [ ! -e "$1" ] || mv -T -- "$1" "$0/up"; [ ! -e "$2" ] || mv -T -- "$2" "$0/work"; }', to, up, work]);
      await run(["sh", "-c", REMOVE, "sh", to]);
    }
    // The locks of sessions that ran here long ago.
    let by: string[] = [];
    try { by = readdirSync(join(dir, "slots", "by")); } catch {} // none
    const gone = by.filter((n) => { try { return now - statSync(join(dir, "slots", "by", n)).mtimeMs > LAYER_KEEP_MS; } catch { return false; } }).map((n) => join(dir, "slots", "by", n));
    if (gone.length) await remove(gone);
  }
}
// How much the sandboxes hold on disk, in bytes (du, off the loop).
export async function sandboxBytes(): Promise<number> {
  try {
    const p = Bun.spawn(["du", "-sb", sandboxRoot()], { stdout: "pipe", stderr: "ignore" });
    const out = await readText(p.stdout, "du");
    await p.exited;
    return Number(out.split(/\s/)[0]) || 0;
  } catch {
    return 0;
  }
}

// ---- the toolchains of a home ----

const LIB_LIKE = ["lib", "lib64", "libexec", "share", "include"];
// What a PATH folder's toolchain is, beside the folder itself: the folder
// above a `bin` that has the rest of a toolchain beside it (lib, share,
// ...), when that is not the home, its .local, or somebody's repository.
// For a dot-folder directly in the home (~/.tool/bin), where a tool keeps
// its sign-in beside its programs: the lib-like folders only, never the whole.
function rootOfBin(bin: string, home: string): string[] {
  if (basename(bin) !== "bin" && basename(bin) !== "sbin") return [];
  const up = dirname(bin);
  if (up === home || up === join(home, ".local") || !hiddenPlace(up, home) || contains(up, home) || kind(join(up, ".git")) !== "none") return [];
  // (Not `pkg` or `src`: a Go workspace has those beside its bin, and its module cache in them.)
  const libs = LIB_LIKE.filter((n) => isDir(join(up, n)));
  if (!libs.length) return [];
  return dirname(up) === home && basename(up).startsWith(".") ? libs.map((n) => join(up, n)) : [up];
}

const runnable = (p: string) => { try { const st = statSync(p); return st.isFile() && (st.mode & 0o111) !== 0; } catch { return false; } };
const found = new Map<string, { at: number; paths: string[] }>();
// The files git's global config names for every repository (ignore patterns,
// attributes): data a `git status` is wrong without.
let gitKept: { mark: string; files: string[] } | undefined;
function gitFiles(home: string): string[] {
  // (git is asked again only when one of its global config files changed.)
  const mark = [join(home, ".gitconfig"), join(home, ".config/git/config")].map((f) => { try { const st = statSync(f); return `${st.ino}:${st.size}:${st.mtimeMs}`; } catch { return "-"; } }).join("|") + home;
  if (gitKept?.mark === mark) return gitKept.files;
  const out: string[] = [];
  for (const key of ["core.excludesFile", "core.attributesFile"]) {
    // (Through src/core/git.ts, as every git the daemon runs. No repository is read.)
    const r = gitSync("/", ["config", "--global", "--type=path", "--get", key], { mode: "plain", timeout: 3_000 });
    const p = r.code === 0 ? r.out.trim() : "";
    if (p && isAbsolute(p) && under(home, p)) out.push(p);
  }
  gitKept = { mark, files: out };
  return out;
}
// What of the real home a command needs to run the owner's toolchains:
// absolute paths that exist, none inside another. Nothing in a credential
// store or one of Keel's own folders, by where it really is; and nothing in
// or followed from `writable`, the folders the sandbox can write (a PATH
// folder there is the workspace's own).
export function toolchainPaths(home = ownerHome(), env: Record<string, string | undefined> = process.env, writable: string[] = []): string[] {
  const key = `${home}\n${env.PATH ?? ""}\n${ROOT_VARS.map((v) => env[v] ?? "").join("\n")}\n${writable.join("\n")}`;
  const have = found.get(key);
  if (have && Date.now() - have.at < 30_000) return have.paths;
  const want = new Set<string>();
  const written = (p: string) => writable.some((w) => contains(w, p) || contains(w, real(p)));
  const add = (p: string) => { if (hiddenPlace(p, home) && !contains(p, home) && kind(p) !== "none" && !written(p) && !storeOf(real(p), home)) want.add(p); };
  for (const rel of [...TOOLCHAINS, ...SETTINGS]) add(join(home, rel));
  for (const p of gitFiles(home)) add(p);
  for (const v of ROOT_VARS) for (const p of (env[v] ?? "").split(":")) {
    if (!p || !isAbsolute(p) || written(p)) continue;
    const skipped = ROOT_SKIPPED[v];
    // A root that holds its cache or its credentials is bound a part at a time.
    if (skipped && isDir(p)) { for (const n of readdirSync(p)) if (!skipped.some((s) => s === n || s.startsWith(`${n}/`))) add(join(p, n)); }
    else add(resolve(p));
  }
  for (const entry of (env.PATH ?? "").split(":")) {
    if (!entry || !isAbsolute(entry)) continue;
    const dir = resolve(entry);
    // A folder the sandbox can write is not a toolchain of the owner's: nothing is bound for it, no link in it is followed.
    if (!hiddenPlace(dir, home) || !isDir(dir) || written(dir)) continue;
    add(dir);
    for (const root of rootOfBin(real(dir), home)) add(root);
    // What the links in it point at: a tool installed elsewhere in the home.
    let names: string[] = [];
    try { names = readdirSync(dir); } catch {} // unreadable: the folder itself is all there is
    for (const n of names.slice(0, 2_000)) {
      if (kind(join(dir, n)) !== "link") continue;
      const to = real(join(dir, n));
      // (Only a program: a file that can be run. A link there to a document or a folder is not a tool's.)
      if (!hiddenPlace(to, home) || !runnable(to)) continue;
      const roots = rootOfBin(dirname(to), home);
      if (roots.length) { add(dirname(to)); for (const r of roots) add(r); } else add(to);
    }
  }
  // A link is kept as the link it is when what it points at is bound too.
  const links = new Set<string>();
  for (const p of [...want]) if (kind(p) === "link") { add(real(p)); if (want.has(real(p)) || !hiddenPlace(real(p), home)) links.add(p); else want.delete(p); }
  // None inside another (sorted, a folder comes before what it holds).
  const all = [...want].sort();
  const paths: string[] = [];
  let last: string | undefined;
  for (const p of all) {
    if (last !== undefined && contains(last, p)) continue;
    paths.push(p);
    if (!links.has(p)) last = p;
  }
  if (found.size > 64) found.clear();
  found.set(key, { at: Date.now(), paths });
  return paths;
}

// What a program the owner configured needs to start in a sandbox (an
// agent, a language server from the settings): the program with the
// toolchain around it, and the files and folders its arguments name. Only
// for a command line that is the owner's own: one a workspace or an editor
// supplies could name anything.
export function programPaths(argv: string[], env: Record<string, string | undefined> = process.env): string[] {
  const home = ownerHome();
  const out: string[] = [];
  const show = (p: string) => { if (hiddenPlace(p, home) && !contains(p, home) && kind(p) !== "none") out.push(p); };
  const first = argv[0] && (isAbsolute(argv[0]) ? argv[0] : !argv[0].includes("/") ? Bun.which(argv[0], { PATH: env.PATH ?? "" }) : null);
  if (first) {
    const prog = real(first);
    show(dirname(prog));
    for (const r of rootOfBin(dirname(prog), home)) show(r);
    if (prog !== resolve(first)) show(resolve(first));
  }
  for (const a of argv.slice(1, 64)) {
    if (!isAbsolute(a) || a.length > 4096) continue;
    const p = real(a);
    const k = kind(p);
    if (k === "dir") show(p);
    // A script is shown with its folder (what it imports lies beside it), unless that would be the home.
    else if (k === "file") show(dirname(p) === home || contains(dirname(p), home) ? p : dirname(p));
  }
  return [...new Set(out)];
}

// What Keel itself offers a session to read and run: the folders of the
// skills and commands it lists (src/tools/skills.ts names them here). They
// are shown read-only in every sandbox, also the ones in Keel's own config
// folder: a skill's script must run where the session's commands run.
const offered: (() => string[])[] = [];
export const offerToSandbox = (f: () => string[]) => void offered.push(f);
export const offeredPaths = () => [...new Set(offered.flatMap((f) => { try { return f(); } catch { return []; } }))].filter((p) => kind(p) === "dir").map(real);

// The other checkouts of a workspace's repository: its main checkout and
// its linked worktrees (an agent's among them, which its parent reads and
// merges). One repository is one place to work in: they are shown
// read-only, and git's own list of worktrees stays true inside.
export function siblings(workspace: string, worktrees: string[] = []): string[] {
  try {
    const at = locate(workspace);
    if (!at) return [];
    const ws = real(workspace);
    // What names a checkout is in the git directory. A sandboxed command cannot write it (a main checkout's git
    // directory is read-only in its sandbox, and a worktree's view of it too), but a command the owner let out of
    // the sandbox can. So a checkout is taken only when it and the repository name each other: its own `.git` file
    // points back at the directory that names it. A forged entry needs that file in a folder the sandbox could
    // already write.
    const back = (dot: string, dir: string): boolean => {
      if (basename(dot) !== ".git" || !isAbsolute(dot) || kind(dot) !== "file") return false;
      const named = /^gitdir: (.+)$/m.exec(readFileSync(dot, "utf8"))?.[1]?.trim();
      return !!named && real(isAbsolute(named) ? named : join(dirname(dot), named)) === real(dir);
    };
    // The session's own pointer first: a linked worktree whose repository does not name it has no repository here.
    if (at.top && at.gitDir !== at.common) {
      let named = "";
      try { named = readFileSync(join(at.gitDir, "gitdir"), "utf8").trim(); } catch {} // not a worktree's directory
      if (basename(named) !== ".git" || real(dirname(isAbsolute(named) ? named : join(at.gitDir, named))) !== real(at.top)) return [];
    }
    const out = new Set<string>();
    if (basename(at.common) === ".git" && kind(at.common) === "dir") out.add(real(dirname(at.common)));
    const [state] = ownFolders() as [string, string];
    let names: string[] = [];
    try { names = readdirSync(join(at.common, "worktrees")); } catch {} // no linked worktrees
    for (const name of names.slice(0, 512)) {
      const dir = join(at.common, "worktrees", name);
      let dot: string;
      try { dot = readFileSync(join(dir, "gitdir"), "utf8").trim(); } catch { continue; }
      if (!back(dot, dir)) continue;
      const folder = real(dirname(dot));
      // In Keel's own state only a worktree Keel made for this session's own agents (the store knows which: the
      // caller names them): another session's is that session's.
      if (contains(state, folder) && !(dirname(folder) === join(state, "worktrees") && worktrees.some((w) => real(w) === folder))) continue;
      out.add(folder);
    }
    // (Not the session's folder, a folder around it, or one inside it: that one is the session's own.)
    return [...out].filter((p) => !contains(p, ws) && !contains(ws, p) && isDir(p));
  } catch {
    return [];
  }
}

// A folder of the owner's list as a path: absolute, or under ~. Never the root.
export function readPath(entry: string, home = ownerHome()): string | undefined {
  const t = entry.trim();
  const p = t === "~" ? home : t.startsWith("~/") ? join(home, t.slice(2)) : t;
  return isAbsolute(p) && resolve(p) !== "/" ? resolve(p) : undefined;
}

// The files Keel reads its own configuration from when the owner keeps them outside its config folder (a variable
// names each): its hooks, MCP servers, ACP agents and their folders. Keel runs what they name, outside any sandbox.
export const namedConfig = (env: Record<string, string | undefined> = process.env): string[] =>
  [env.KEEL_HOOKS, env.KEEL_MCP_CONFIG, env.KEEL_ACP_AGENTS, env.KEEL_ACP_FOLDERS].filter((x): x is string => !!x && isAbsolute(x)).map(real);

// ---- small files, in one folder ----

// A bind is the dear part of building a sandbox (each one makes bubblewrap
// read the machine's whole mount table). The small files a sandbox shows
// (git's config, version files, cargo's config, the registry settings, the
// profile) are kept as copies in one folder, bound once, and each is a
// link to its copy there. A copy is made again when the owner's file changed.
const FILES_AT = "/run/keel-sandbox-files";
const filesDir = () => join(sandboxRoot(), "files");
const SMALL_MAX = 256 * 1024;
function copied(src: string, name: string): boolean {
  const copy = join(filesDir(), name);
  try {
    const st = statSync(src);
    if (!st.isFile() || st.size > SMALL_MAX) return false;
    let have: { mtimeMs: number; size: number } | undefined;
    try { have = statSync(copy); } catch {} // not made yet
    if (have?.mtimeMs !== st.mtimeMs || have.size !== st.size) {
      mkdirSync(filesDir(), { recursive: true, mode: 0o700 });
      writeFileSync(`${copy}.new`, readFileSync(src), { mode: 0o644 });
      utimesSync(`${copy}.new`, st.atime, st.mtime);
      renameSync(`${copy}.new`, copy);
    }
    return true;
  } catch {
    return false; // unreadable: it is bound as it is
  }
}

// ---- the package managers' settings ----

// A URL without the user and password in it.
const noUser = (line: string) => line.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s"'@]+@/gi, "$1");
const pipLine = (l: string) => (/^\s*\[[^\]]+\]\s*$/.test(l) || /^\s*(index-url|extra-index-url|trusted-host|find-links)\s*=/.test(l) ? noUser(l) : null);
// bunfig.toml: the section headers and the registries, a registry given with a token as its address alone.
function bunLine(l: string): string | null {
  if (/^\s*\[[^\]]+\]\s*$/.test(l)) return l;
  const m = /^(\s*(?:registry|"@[\w.-]+"|@[\w.-]+)\s*=\s*)(.*)$/.exec(l);
  if (!m) return null;
  const url = /url\s*=\s*("[^"]*"|'[^']*')/.exec(m[2]!)?.[1] ?? /^("[^"]*"|'[^']*')/.exec(m[2]!.trim())?.[1];
  return url ? noUser(`${m[1]}${url}`) : null;
}
// Settings of package managers in a home that hold a token beside what
// decides where packages come from. They are hidden (CREDENTIALS). Their
// registry lines are passed on without the tokens: with a registry setting
// gone a private package's name would be asked of the public registry,
// where anyone can publish under it. Without its token the private
// registry refuses, which is said and safe.
const REGISTRY_FILES: { rel: string; keep: (line: string) => string | null }[] = [
  { rel: ".npmrc", keep: (l) => (/^\s*(@[\w.-]+:)?registry\s*=/.test(l) ? noUser(l) : null) },
  { rel: ".config/pip/pip.conf", keep: pipLine },
  { rel: ".pip/pip.conf", keep: pipLine },
  { rel: ".bunfig.toml", keep: bunLine },
  { rel: ".config/uv/uv.toml", keep: (l) => (/^\s*\[\[?[^\]]+\]\]?\s*$/.test(l) || /^\s*(index-url|extra-index-url|url|name|default|index-strategy)\s*=/.test(l) ? noUser(l) : null) },
];
// The copies a sandbox gets, as [file on disk, the path it is found at]: made again when the owner's file changed.
export function registrySettings(home = ownerHome()): [string, string][] {
  const out: [string, string][] = [];
  const root = filesDir();
  for (const f of REGISTRY_FILES) {
    const src = join(home, f.rel);
    let st: ReturnType<typeof statSync>;
    try { st = statSync(src); } catch { continue; } // the owner has none
    if (!st.isFile() || st.size > 1_000_000) continue;
    const copy = join(root, `registry__${f.rel.replaceAll("/", "__")}`);
    let have = 0;
    try { have = statSync(copy).mtimeMs; } catch {} // not made yet
    if (have !== st.mtimeMs) {
      try {
        const kept = readFileSync(src, "utf8").split("\n").map(f.keep).filter((l): l is string => l !== null);
        mkdirSync(root, { recursive: true, mode: 0o700 });
        writeFileSync(copy, `${kept.join("\n")}\n`, { mode: 0o644 });
        utimesSync(copy, st.atime, st.mtime);
      } catch { continue; } // unreadable: nothing is passed on
    }
    out.push([copy, src]);
  }
  return out;
}
// The settings files of a home that are hidden from every sandbox and change what tools do there: named to the owner
// (Settings) and to a command that ran into one.
const SETTINGS_HIDDEN = [".npmrc", ".yarnrc.yml", ".pypirc", ".config/pip/pip.conf", ".pip/pip.conf", ".bunfig.toml", ".config/uv/uv.toml", ".gemrc", ".m2/settings.xml",
  ".gradle/gradle.properties", ".docker/config.json", ".netrc", ".config/pnpm/rc", ".ssh/config", ".config/gh/hosts.yml", ".cargo/credentials.toml"];
let hiddenKept: { at: number; home: string; list: { path: string; note?: string }[] } | undefined;
export function hiddenSettings(home = ownerHome()): { path: string; note?: string }[] {
  if (hiddenKept && hiddenKept.home === home && Date.now() - hiddenKept.at < 30_000) return hiddenKept.list;
  const passed = new Set(REGISTRY_FILES.map((f) => f.rel));
  const list: { path: string; note?: string }[] = SETTINGS_HIDDEN.filter((rel) => kind(join(home, rel)) !== "none")
    .map((rel) => ({ path: `~/${rel}`, ...(passed.has(rel) ? { note: "its registry lines are passed on without tokens" } : {}) }));
  // What git's global config includes from a file the sandbox does not show: git reads past a missing include in silence.
  const inc = gitSync("/", ["config", "--global", "--type=path", "--get-all", "include.path"], { mode: "plain", timeout: 3_000 });
  if (inc.code === 0) for (const p of inc.out.split("\n").map((l) => l.trim()).filter(Boolean)) {
    const at = isAbsolute(p) ? p : join(home, p);
    if (kind(at) !== "none" && !SETTINGS.some((rel) => join(home, rel) === at)) list.push({ path: tilde(at, home), note: "included by git's global config" });
  }
  hiddenKept = { at: Date.now(), home, list };
  return list;
}

// ---- the environment ----

// The names of the daemon's environment a sandboxed command keeps: what a
// build needs to find its tools and say things right. Everything else is
// taken out, and so is a kept name that looks like a credential or holds a
// URL with a password. (What a tool adds for one call, such as a secret the
// owner gave the session under a name, is not the daemon's and stays.)
const ENV_KEPT = /^(PATH|HOME|USER|LOGNAME|SHELL|PWD|OLDPWD|SHLVL|HOSTNAME|LANG|LANGUAGE|LC_[A-Z_]+|TZ|TERM|TERMINFO|TERMINFO_DIRS|COLORTERM|COLUMNS|LINES|NO_COLOR|FORCE_COLOR|CLICOLOR|CLICOLOR_FORCE|CI|TMPDIR|TEMP|TMP|EDITOR|VISUAL|PAGER|GIT_PAGER|SYSTEMD_PAGER|DPKG_PAGER|MANPAGER|LESS|XDG_[A-Z_]+|DEBIAN_FRONTEND|SOURCE_DATE_EPOCH|MAKEFLAGS|MAKELEVEL|CC|CXX|CPP|LD|AR|CFLAGS|CXXFLAGS|CPPFLAGS|LDFLAGS|PKG_CONFIG_PATH|LD_LIBRARY_PATH|LIBRARY_PATH|CPATH|C_INCLUDE_PATH|CPLUS_INCLUDE_PATH|CMAKE_[A-Z_]+|RUSTFLAGS|RUSTUP_TOOLCHAIN|RUSTC_WRAPPER|CARGO_[A-Z_]+|GOPATH|GOBIN|GOFLAGS|GOTOOLCHAIN|GOPROXY|GONOSUMDB|GONOSUMCHECK|GOPRIVATE|GO111MODULE|CGO_[A-Z_]+|PYTHONPATH|PYTHONHOME|PYTHONUNBUFFERED|PYTHONDONTWRITEBYTECODE|PIP_[A-Z_]+|UV_[A-Z_]+|CONDA_[A-Z_]+|NODE_PATH|NODE_ENV|NODE_OPTIONS|NVM_[A-Z_]+|BUN_[A-Z_]+|DENO_[A-Z_]+|JAVA_OPTS|JAVA_TOOL_OPTIONS|GRADLE_USER_HOME|MAVEN_OPTS|M2_HOME|ANDROID_[A-Z_]+|DOTNET_[A-Z_]+|GEM_PATH|BUNDLE_PATH|SSH_AUTH_SOCK|GIT_[A-Z_0-9]+|KEEL_SESSION|KEEL_SANDBOX_[A-Z_]+|TRACEPARENT|TRACESTATE)$/;
const ENV_SECRET = /TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|APIKEY|API_KEY|PRIVATE_KEY|ACCESS_KEY|(^|_)AUTH(_|$)|(^|_)KEY$/i;
// A URL that carries a sign-in before its host: a user and a password, or a token alone (https://token@host).
const URL_SIGN_IN = /(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi;
// A value that carries a sign-in under a name a build keeps: a header (Authorization: ..., Bearer ...), a token
// in a URL's query, a netrc line, a field of JSON, a flag that sets one (GOFLAGS -X main.token=...). Such a
// variable goes whole: there is no telling what of it is safe.
const VALUE_SECRET = /\b(proxy-)?authorization\s*:|\b(bearer|basic)\s+[A-Za-z0-9._~+\/=-]{8,}|\b(login|password|passwd)\s+\S+\s*$|\bpassword\s+\S|[?&;.\s"'{,_-](access[_-]?token|auth[_-]?token|token|api[_-]?key|apikey|secret|password|passwd|credentials?)["']?\s*[=:]\s*["']?[^\s"'&]/i;
// git settings given through the environment (GIT_CONFIG_COUNT, GIT_CONFIG_KEY_n, GIT_CONFIG_VALUE_n): a pair that
// carries a sign-in (an Authorization header, a credential helper, a URL with one).
const GIT_PAIR_SECRET = /authorization\s*:|\b(bearer|basic)\s+\S|token|passw|secret|credential/i;
const GIT_KEY_SECRET = /extraheader|credential|proxyauth|password|token/i;
// What happens to the daemon's environment on the way into a sandbox: the names taken out, and the values put in
// changed (a URL kept without its sign-in). `more`: names the owner keeps besides (Settings).
export function envPlan(env: Record<string, string | undefined> = process.env, more: string[] = []): { drop: string[]; set: [string, string][] } {
  const kept = new Set([...ROOT_VARS, ...more]);
  const drop: string[] = [], set: [string, string][] = [];
  // git's settings: all of them go when one pair carries a sign-in (the pairs are numbered: one cannot be taken out alone).
  const count = Number(env.GIT_CONFIG_COUNT ?? 0);
  let gitSecret = false;
  for (let i = 0; i < Math.min(Number.isFinite(count) ? count : 0, 256) && !gitSecret; i++) {
    const k = env[`GIT_CONFIG_KEY_${i}`] ?? "", v = env[`GIT_CONFIG_VALUE_${i}`] ?? "";
    gitSecret = GIT_KEY_SECRET.test(k) || GIT_PAIR_SECRET.test(v) || new RegExp(URL_SIGN_IN.source, "i").test(v) || new RegExp(URL_SIGN_IN.source, "i").test(k);
  }
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const owners = more.includes(name);
    const named = kept.has(name) || ENV_KEPT.test(name);
    const secret = ENV_SECRET.test(name) && name !== "SSH_AUTH_SOCK" && !owners;
    if (!named || secret || (gitSecret && /^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/.test(name))) { drop.push(name); continue; }
    // (A name the owner listed is theirs to pass whole.)
    if (owners) continue;
    const plain = value.replace(URL_SIGN_IN, "$1");
    // (A sign-in that is not a URL's own: nothing of the value is kept.)
    if (VALUE_SECRET.test(plain) && !/^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/.test(name)) { drop.push(name); continue; }
    if (plain !== value) set.push([name, plain]);
  }
  return { drop, set };
}
// The names to take out of a sandboxed command's environment.
export const envDropped = (env: Record<string, string | undefined> = process.env, more: string[] = []): string[] => envPlan(env, more).drop;

// ---- the view ----

export type View = {
  // The bwrap arguments that come before the workspace's own binds.
  before: string[];
  // After them: the credential stores and Keel's own folders, hidden inside whatever was bound.
  masks: string[];
  // The workspace lies inside one of Keel's own folders that was hidden (a worktree Keel made): its binds are made again after the masks.
  again: boolean;
  // Then what Keel itself gives the session from its own folders or from inside a store (its skills, the session's files, the SSH agent's settings).
  after: string[];
  // Last of all: the sandbox's home closed (what is bound in it keeps its own mode).
  last: string[];
  // Variables taken out of the command's environment.
  unset: string[];
  // Variables a command gets unless its own environment sets them: where the sandbox's cache and state folders are.
  defaults: [string, string][];
  home: string;
  // The real paths a command sees as they are (toolchains, settings, the owner's list, Keel's offers, the caches).
  shown: string[];
  // The cache layers, when the caches are layered: the folder their locks are in (the command's wrapper takes one),
  // the bwrap arguments that mount them and the folders they need, each with SLOT where the slot's number goes.
  // They come right after `before`.
  layers?: { slots: string; args: string[]; dirs: string[] };
};

// A login shell reads the profile of the home, and the system's own profile
// may set PATH anew before it: the sandbox's home says the PATH the command
// was started with, so the owner's toolchains are found there too.
const PROFILE = '# Written by Keel for its sandbox: the PATH the command was started with.\n[ -n "$KEEL_SANDBOX_PATH" ] && PATH="$KEEL_SANDBOX_PATH:$PATH" && export PATH\n';
// Files the sandbox itself makes, under its root: an empty one nobody can read (what stands in for a hidden file), the profile.
function ownFile(name: string, text: string, mode: number): string {
  const at = join(sandboxRoot(), name);
  if (kind(at) !== "file") { mkdirSync(dirname(at), { recursive: true, mode: 0o700 }); writeFileSync(at, text, { mode }); }
  return at;
}
// The folders already made for a list of paths: nothing is made twice.
const laid = new Map<string, string>();

// What is kept between views (the toolchains found, the folders made, the hidden settings) is dropped: the next view reads the disk again.
export function forgetViews() { found.clear(); laid.clear(); hiddenKept = undefined; installedKept = undefined; gitKept = undefined; }

// The lists a view is made from, for a workspace: also what the file tools' rule reads (shownTo).
type Lists = { home: string; ws: string; listed: string[]; links: string[]; tools: string[]; offers: string[]; beside: string[]; mine: string[] };
// `at`: where the folder is, when the caller holds that already (the gate's pin of a session's folder): its name is
// not walked again, since it may lead somewhere else by now.
function listsOf(workspace: string, o: ReadOpts, env: Record<string, string | undefined>, offers = offeredPaths(), at?: string): Lists {
  const home = ownerHome();
  const ws = at ?? real(workspace);
  // What the owner added. An entry in one of Keel's own folders is never taken (one that holds them has them hidden
  // in it, below); a credential store is, when the entry names it.
  const entries = (o.read ?? []).map((e) => readPath(e, home)).filter((p): p is string => !!p && kind(p) !== "none");
  const ok = (p: string) => !ownFolders().some((own) => contains(own, real(p)));
  const listed = entries.filter(ok).map(real);
  // (An entry that is a link is there under its own name too, as a link to what it points at.)
  const links = entries.filter((p) => ok(p) && kind(p) === "link" && !listed.some((l) => contains(l, p)));
  // The toolchains: nothing in or followed from what the sandbox writes.
  const tools = toolchainPaths(home, env, [ws]).filter((p) => !listed.some((l) => contains(l, p)));
  // The repository's other checkouts: not one inside a credential store.
  const beside = siblings(workspace, o.worktrees).filter((p) => { const s = storeOf(p, home); return !s || s.own; });
  const mine = (o.own ?? []).filter(isDir).map(real);
  return { home, ws, listed, links, tools, offers, beside, mine };
}

// `layered`: the caches get a layer of the slot the command's wrapper takes (overlays can be mounted here and the
// wrapper is there to take a slot). `offers`: what Keel offers every session (given by the caller when this runs on
// another thread, where nothing is registered).
export function readView(workspace: string, profile: "workspace-write" | "read-only", o: ReadOpts = {}, env: Record<string, string | undefined> = process.env, layered = false, offers?: string[]): View {
  const L = listsOf(workspace, o, env, offers);
  const { home, ws, listed, tools, beside, mine } = L;
  const before: string[] = [];
  const own = sandboxHome(sandboxScope(workspace));
  const rw = profile === "read-only" ? "--ro-bind" : "--bind";
  // The top of the file system: what is no system folder is not there.
  let top: string[] = [];
  try { top = readdirSync("/"); } catch {} // unreadable: the home is still hidden below
  for (const name of top) if (!SYSTEM.has(name) && kind(`/${name}`) === "dir") before.push("--tmpfs", `/${name}`);
  for (const name of VAR_HIDDEN) if (kind(`/var/${name}`) === "dir") before.push("--tmpfs", `/var/${name}`);
  // /run: empty, but for the resolver's file and the system's own program folders.
  const resolv = real("/etc/resolv.conf");
  before.push("--tmpfs", "/run");
  if (under("/run", resolv) && kind(resolv) === "file") before.push("--ro-bind", resolv, resolv);
  for (const p of RUN_KEPT) if (kind(p) !== "none") before.push("--ro-bind", p, p);
  const runtime = env.XDG_RUNTIME_DIR && under("/run", resolve(env.XDG_RUNTIME_DIR)) ? resolve(env.XDG_RUNTIME_DIR) : `/run/user/${userInfo().uid}`;
  before.push("--perms", "0700", "--dir", runtime);

  // The home: an empty folder in memory (unless the session's folder is the home or holds it: then that is the home).
  const homeIsWorkspace = contains(ws, home);
  if (!homeIsWorkspace) {
    before.push("--tmpfs", home);
    // (A home reached through a link keeps that name.)
    const named = resolve(process.env.HOME && isAbsolute(process.env.HOME) ? process.env.HOME : homedir());
    if (named !== home) before.push("--symlink", home, named);
  }
  // What is shown of the real machine as it is, read-only: the owner's list, the toolchains, the repository's other
  // checkouts that are not in Keel's own folders. A link is made as a link to where it ends.
  const inOwn = (p: string) => ownFolders().some((d) => contains(d, p));
  const shown = [...new Set([...listed, ...L.links, ...tools, ...beside.filter((p) => !inOwn(p))])].sort();
  // (A small settings file is a link to its copy in the one folder of files, where a link can be made: in the home in
  // memory, not inside something bound.)
  const small = new Set([...[...SETTINGS, ".cargo/config.toml", ".cargo/config", ".cargo/env"].map((rel) => join(home, rel)), ...gitFiles(home)]);
  const linkable = (dest: string) => !homeIsWorkspace && under(home, dest) && !listed.some((l) => contains(l, dest)) && !shown.some((s) => s !== dest && kind(s) !== "link" && contains(s, dest));
  const files: [string, string][] = [];
  for (const p of shown) {
    const name = `home__${p.slice(home.length + 1).replaceAll("/", "__")}`;
    if (kind(p) === "link") before.push("--symlink", real(p), p);
    else if (small.has(p) && linkable(p) && copied(p, name)) files.push([name, p]);
    else before.push("--ro-bind", p, p);
  }
  // The package managers' registry settings, without their tokens.
  for (const [copy, at] of registrySettings(home)) {
    if (listed.some((l) => contains(l, at))) continue;
    if (linkable(at)) files.push([basename(copy), at]);
    else before.push("--ro-bind", copy, at);
  }
  for (const f of [".profile", ".zprofile"]) if (linkable(join(home, f))) { ownFile("files/profile", PROFILE, 0o644); files.push(["profile", join(home, f)]); }
  if (files.length) before.push("--ro-bind", filesDir(), FILES_AT);
  for (const [name, dest] of files) before.push("--symlink", `${FILES_AT}/${name}`, dest);

  // Where the XDG cache and state folders are: the owner's environment may name them, else in the sandbox's own folder
  // (under /tmp when the owner's list shows the real home whole).
  const rwAt = shown.some((p) => contains(p, join(home, RW))) ? join("/tmp", RW) : join(home, RW);
  const defaults: [string, string][] = [];
  const xdg: Record<string, string> = {};
  for (const [name, dir] of XDG) {
    const set = env[name];
    if (set && isAbsolute(set) && resolve(set) !== "/") xdg[dir] = resolve(set);
    else { xdg[dir] = join(rwAt, dir); defaults.push([name, xdg[dir]!]); }
  }
  // The caches. `at`: where the command finds it; `from`: the owner's real one; `key`: its layer's name on disk.
  // Not one in a store, or the workspace's own.
  const realCache = env.XDG_CACHE_HOME && isAbsolute(env.XDG_CACHE_HOME) ? resolve(env.XDG_CACHE_HOME) : join(home, ".cache");
  const all = [
    ...CACHES.map((rel) => ({ at: join(home, rel), from: join(home, rel), key: rel, root: join(home, TOOL_ROOT(rel)) as string | undefined })),
    ...XDG_CACHES.map((name) => ({ at: join(xdg.cache!, name), from: join(realCache, name), key: join(".cache", name), root: undefined as string | undefined })),
  ].filter((c) => !contains(c.from, ws) && !contains(ws, c.from) && !storeOf(c.from, home));
  // (A cache that is a link is not layered: where it points is not this list's to open.)
  const layers = layered ? all.filter((c) => kind(c.from) === "dir") : [];
  // The sandbox's own folders: where tools keep logs and locks; a cache the owner has none of yet (the whole of a
  // tool's folder when that is not there either: a first use); and every cache where no layer can be made.
  const covered = (p: string) => shown.some((s) => contains(s, p) || contains(p, s));
  const plain = new Set<string>();
  for (const rel of PRIVATE) if (kind(join(home, rel.includes("/") ? dirname(rel) : rel)) !== "none" || rel === ".npm") plain.add(join(home, rel));
  const installed = installedRoots(env);
  for (const c of all) {
    if (c.root === undefined || layers.includes(c)) continue;
    if (kind(c.root) === "none") { if (installed.has(c.root.slice(home.length + 1))) plain.add(c.root); }
    else if (kind(c.from) !== "link") plain.add(c.at);
  }
  const privates = homeIsWorkspace ? [] : [...plain].filter((p) => !covered(p)).sort().filter((p, _i, a) => !a.some((q) => q !== p && contains(q, p)));
  const enc = (key: string) => key.replaceAll("/", "__");
  const disk = (p: string) => join(own.rw, p.slice(home.length + 1));
  // What must be on disk before the view is built: the sandbox's own folders, and a place for a layer inside one of them.
  const layout = [...privates, ...layers.map((c) => c.at), rwAt].join("\n");
  if (laid.get(own.dir) !== layout) {
    for (const [, dir] of XDG) mkdirSync(join(own.rw, RW, dir), { recursive: true });
    for (const p of privates) mkdirSync(disk(p), { recursive: true });
    for (const c of layers) {
      if (under(xdg.cache!, c.at)) mkdirSync(join(own.rw, RW, "cache", c.at.slice(xdg.cache!.length + 1)), { recursive: true });
      else if (privates.some((p) => under(p, c.at))) mkdirSync(disk(c.at), { recursive: true });
    }
    if (laid.size > 256) laid.clear();
    laid.set(own.dir, layout);
  }
  before.push(rw, join(own.rw, RW), rwAt);
  for (const [, dir] of XDG) if (xdg[dir] !== join(rwAt, dir)) before.push(rw, join(own.rw, RW, dir), xdg[dir]!);
  for (const p of privates) before.push(rw, disk(p), p);
  // The caches, copy-on-write: the owner's real one below, the layer of the command's slot above.
  const layerArgs: string[] = [], layerDirs: string[] = [];
  for (const c of layers) {
    const up = join(own.dir, "up", SLOT, enc(c.key)), work = join(own.dir, "work", SLOT, enc(c.key));
    layerDirs.push(up);
    if (profile === "read-only") layerArgs.push("--overlay-src", c.from, "--overlay-src", up, "--ro-overlay", c.at);
    else { layerArgs.push("--overlay-src", c.from, "--overlay", up, work, c.at); layerDirs.push(work); }
    // A tool that names ~/.cache itself finds its cache there too.
    if (c.key.startsWith(".cache/") && rwAt === join(home, RW) && !contains(realCache, c.at) && !homeIsWorkspace) before.push("--symlink", c.at, join(home, c.key));
  }
  // The temp folder: the sandbox's own, bound there.
  const tmp = env.TMPDIR && isAbsolute(env.TMPDIR) && !contains("/tmp", resolve(env.TMPDIR)) ? resolve(env.TMPDIR) : undefined;
  if (tmp) before.push(rw, own.tmp, tmp);

  // After the workspace: the stores and Keel's own folders, hidden inside whatever was bound. A store the owner's
  // list names, or one the workspace itself is in, is the owner's choice.
  const regions = [ws, ...shown.filter((p) => kind(p) !== "link"), ...layers.map((c) => c.at)];
  const masks: string[] = [];
  const masked: string[] = [];
  for (const rel of CREDENTIALS) {
    const p = join(home, rel);
    const k = kind(p);
    if (k === "none" || k === "link" || contains(p, ws) || listed.some((l) => contains(p, l))) continue;
    if (!regions.some((r) => under(r, p))) continue;
    masks.push(...(k === "dir" ? ["--tmpfs", p] : ["--ro-bind", ownFile("hidden", "", 0o000), p]));
    masked.push(p);
  }
  let again = false;
  for (const dir of ownFolders()) {
    if (!isDir(dir) || !regions.some((r) => contains(r, dir))) continue;
    masks.push("--tmpfs", dir);
    masked.push(dir);
    if (contains(dir, ws)) again = true;
  }
  // Then what Keel itself gives the session: its skills and commands (also the ones kept in a harness's folder that
  // is a store, or in Keel's config), the session's own files in Keel's state, a worktree Keel made of the same
  // repository, and for the SSH agent the hosts it knows and the client's settings.
  const after: string[] = [];
  // (One that a mask just hid is bound again; one the workspace or the owner's list already shows is left as it is.)
  const given = [...new Set([...L.offers, ...beside.filter(inOwn), ...mine])]
    .filter((p) => !contains(p, ws) && (masked.some((m) => contains(m, p)) || !(contains(ws, p) || listed.some((l) => contains(l, p)))));
  for (const p of given) after.push("--ro-bind", p, p);
  const agent = o.sshAgent && env.SSH_AUTH_SOCK && isAbsolute(env.SSH_AUTH_SOCK) && kind(env.SSH_AUTH_SOCK) === "other" ? env.SSH_AUTH_SOCK : undefined;
  if (agent) {
    after.push("--ro-bind", agent, agent);
    for (const f of ["known_hosts", "config"]) { const p = join(home, ".ssh", f); if (kind(p) === "file") after.push("--ro-bind", p, p); }
  }
  // (The names of the session's desktop and agents. The rest of the daemon's environment is judged when a command
  // starts, by what the environment holds then: envPlan.)
  const unset = ["DBUS_SESSION_BUS_ADDRESS", "XAUTHORITY", "DISPLAY", "WAYLAND_DISPLAY", "GNOME_SETUP_DISPLAY", "GPG_AGENT_INFO", "SSH_AGENT_PID", ...(agent ? [] : ["SSH_AUTH_SOCK"])];
  // Last of all the home is closed: only the sandbox's own folders in it, the workspace and what was bound stay as they are.
  return {
    before, masks, again, after, last: homeIsWorkspace ? [] : ["--remount-ro", home], unset, defaults, home,
    shown: [...shown, ...given, ...layers.map((c) => c.from)], ...(layers.length ? { layers: { slots: join(own.dir, "slots"), args: layerArgs, dirs: layerDirs } } : {}),
  };
}

// ---- one rule for commands and file tools ----

// In Keel's config folder, what a session is told to read: its skills,
// commands and agents, and the owner's instruction files.
const CONFIG_OPEN = /^(skills|commands|agents|[^/]+\.md)$/;

// Whether a sandboxed session's file tool reads a path as its commands
// would: what the view shows, and nothing else without the owner. `store`:
// the path is in a credential store or one of Keel's own folders, which no
// mode reads without the owner. `scratch`: the session's own writable
// folders in Keel's state (its outputs, its artifacts).
// `pinned`: the workspace is given as where it is (the gate's pin): it is not resolved again.
export function shownTo(path: string, workspace: string, o: ReadOpts = {}, scratch: string[] = [], pinned = false): { shown: true } | { shown: false; store: boolean; why: string } {
  const L = listsOf(workspace, o, process.env, undefined, pinned ? workspace : undefined);
  const { home, ws, listed } = L;
  // (The path whole, whatever characters its names hold: a pattern was cut where it was read, readPaths.)
  const p = real(path);
  const how = "The owner can add a folder to what this session's folder may read, in Settings, Permissions.";
  // The stores and Keel's own folders first, wherever the session's folder is.
  const store = storeOf(p, home);
  if (store?.own) {
    const mine = [...L.mine, ...scratch.map(real), ...L.offers, ...L.beside];
    // (A session whose folder is inside one of Keel's own, a worktree Keel made, works there.)
    if (mine.some((d) => contains(d, p)) || (under(store.path, ws) && contains(ws, p))) return { shown: true };
    const [, config] = ownFolders() as [string, string];
    if (store.path === config && p !== config && CONFIG_OPEN.test(p.slice(config.length + 1).split("/")[0]!)) return { shown: true };
    return { shown: false, store: true, why: `it reads ${tilde(p, home)}, one of Keel's own files (the sessions' store, its token, its settings, another session's files), which no session's sandbox shows` };
  }
  if (store) {
    if (listed.some((l) => contains(store.path, l) && (contains(l, p) || contains(p, l))) || L.offers.some((d) => contains(d, p))) return { shown: true };
    // (A session whose folder is inside the store works there by the owner's choice.)
    if (contains(store.path, ws) && contains(ws, p)) return { shown: true };
    return { shown: false, store: true, why: `it reads ${tilde(p, home)}, where the owner's credentials, history or sign-in settings are kept (${tilde(store.path, home)}), which this session's sandbox keeps from its commands. ${how}` };
  }
  if (contains(ws, p)) return { shown: true };
  if (!hiddenPlace(p, home)) {
    // The system, but for what a sandbox has as its own.
    const closed = [...SYSTEM_OWN, ...VAR_HIDDEN.map((n) => `/var/${n}`)].some((d) => contains(d, p)) && !RUN_KEPT.some((d) => contains(d, p));
    if (!closed) return { shown: true };
  } else {
    if ([...listed, ...L.tools, ...L.offers, ...L.beside, ...L.mine, ...scratch.map(real)].some((d) => contains(d, p))) return { shown: true };
    // The owner's package caches are read by the session's commands (copy-on-write).
    if ([...CACHES.map((rel) => join(home, rel)), ...XDG_CACHES.map((n) => join(home, ".cache", n))].some((d) => contains(d, p))) return { shown: true };
  }
  return { shown: false, store: false, why: `it reads ${tilde(p, home)}, which this session's sandbox does not show its commands. ${how}` };
}

// What a workspace's commands see of the machine as it is, beside the system.
export function shownPaths(workspace: string, o: ReadOpts = {}): string[] {
  const L = listsOf(workspace, o, process.env);
  return [...L.listed, ...L.tools, ...L.offers, ...L.beside, ...L.mine];
}

// ---- what a command is told ----

const CREDENTIAL_SAID = /Permission denied \(publickey|Host key verification failed|could not read (Username|Password) for|Authentication failed for|gh auth login|not logged in(?:to)? |Cannot connect to the Docker daemon|docker\.sock|Unable to locate credentials|NoCredentialProviders|no basic auth credentials|ENEEDAUTH|E401|401 Unauthorized|gpg: (signing failed|no default secret key|can't connect to the (gpg-)?agent|Fatal: can't create directory)|gpg failed to sign the data|Failed to connect to bus|Cannot autolaunch D-Bus|secret-tool|org\.freedesktop\.secrets|xdg-open|no method available for opening|cannot open display/i;
const MISSED = /No such file or directory|cannot (access|open|stat)|not found|ENOENT|does not exist|Permission denied|Read-only file system|EROFS/i;
// Why a confined command did not find what it looked for, when the sandbox
// hid it: one sentence each, with how the owner allows it and how the tool
// asks to run outside. A path under the home that the view does not show is
// named whether it exists or not: the sentence tells nothing about what the
// owner's home holds. `cwd`: where a relative path of the output starts.
export function hiddenSaid(output: string, at: { workspace: string; shown: () => string[]; escape: string; sshAgent?: boolean; cwd?: string }): string[] {
  const home = ownerHome();
  const said: string[] = [];
  const hidden = new Set<string>(), stores = new Set<string>(), writes = new Set<string>();
  if (MISSED.test(output)) {
    const shown = at.shown();
    const ws = real(at.workspace);
    // Paths as programs print them: quoted (a space in it), ~/..., absolute, or relative with a folder in it.
    const found = [...output.matchAll(/'([^'\n]{2,400})'|"([^"\n]{2,400})"|(?:^|[\s:=(])((?:~\/|\.\.?\/|\/)[^\s'"`:)]+)/gm)].map((m) => (m[1] ?? m[2] ?? m[3])!.replace(/[.,;]+$/, ""));
    for (const raw of found) {
      if (hidden.size + stores.size + writes.size >= 4) break;
      if (!/^(~\/|\.\.?\/|\/)/.test(raw)) continue;
      const p = raw.startsWith("~/") ? join(home, raw.slice(2)) : isAbsolute(raw) ? resolve(raw) : resolve(at.cwd ?? at.workspace, raw);
      if (!(contains(home, p) || ownFolders().some((d) => contains(d, p))) || p === home || contains(ws, p) || shown.some((s) => contains(s, p))) continue;
      const line = output.split("\n").find((l) => l.includes(raw)) ?? "";
      if (storeOf(p, home)) stores.add(raw);
      else if (/Read-only file system|EROFS/i.test(line)) writes.add(raw);
      else hidden.add(raw);
    }
  }
  const how = "The owner can add a folder to what this session's folder may read, in Settings, Permissions.";
  // A credential store or one of Keel's own files: no way around is offered.
  if (stores.size) said.push(`This session's sandbox does not show ${[...stores].join(", ")}: the owner's credential stores and Keel's own files are kept from every sandboxed command.`);
  if (hidden.size) said.push(`This session's sandbox does not show ${[...hidden].join(", ")}: the home folder is not readable there, except the toolchains and what the owner listed. ${how} ${at.escape}`);
  if (writes.size) said.push(`This session's sandbox writes only in the session's folder: ${[...writes].join(", ")} is in the home folder, which is read-only there. Caches go under $XDG_CACHE_HOME and temp files under $TMPDIR. ${at.escape}`);
  if (!stores.size && !hidden.size && CREDENTIAL_SAID.test(output)) {
    const settings = hiddenSettings(home).map((s) => s.path);
    said.push(`This session's sandbox hides the owner's credentials: SSH keys${at.sshAgent ? "" : " and the SSH agent"}, tokens of command line tools, the keyring, the GPG agent (a signed commit), the display and the Docker socket are not there, so signing in, signing, pushing to or fetching from a private remote, opening a browser and Docker fail inside it.${settings.length ? ` Hidden settings files: ${settings.slice(0, 8).join(", ")}.` : ""} ${at.sshAgent ? "" : "The owner can let the commands of this session's folder use the SSH agent, or add a folder to what they may read, in Settings, Permissions. "}${at.escape}`);
  }
  return said;
}
