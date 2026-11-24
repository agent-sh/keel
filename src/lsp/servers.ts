// Which language server serves a file. A server is an entry of data: the
// extensions it reads, the files that mark a project's root, and the commands
// that may start it, looked for in the workspace's own modules and on PATH.
// Nothing is installed: a server whose program is not on the machine is
// listed as not found. The owner's settings add an entry, change one or turn
// one off (`diagnostics.servers`); a built-in one is the same shape.
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, join } from "node:path";
import { contains, realOf, homeDir } from "../core/paths.ts";

// One way to start the server. `bin`: a program name, looked for in the
// `node_modules/.bin` of the project root and of the folders between it and
// the session's folder, then in `dirs`, then on PATH. `path`: a glob under
// the same `node_modules` (a package's own binary). `package`/`min`: only
// when that package there is at least that version. `loads`: the program
// loads code the project names (a plugin, a build script, an interpreter).
// `optIn`: used only once the owner turned the server on by name.
export type Candidate = { bin?: string; path?: string; args?: string[]; package?: string; min?: string; dirs?: string[]; loads?: boolean; optIn?: boolean };

export type ServerDef = {
  id: string;
  label: string;
  // Extension (with its dot) to the protocol's language id.
  extensions: Record<string, string>;
  // Files that mark a project root: the outermost folder that has one, from
  // the file up to the session's workspace (`nearest`: the innermost).
  roots: string[];
  nearest?: boolean;
  // Without a root file the server is not started (it would guess the project).
  rootless?: boolean;
  command: Candidate[];
  initialization?: unknown;
  settings?: unknown;
  env?: Record<string, string>;
  // Starts without the owner turning it on. Only servers measured to answer
  // in milliseconds and to run nothing of the workspace are.
  auto: boolean;
  // Files of the root whose change starts the server again.
  restartOn: string[];
  // What it runs of the workspace, for the owner.
  runs: string;
};

const TS = { ".ts": "typescript", ".tsx": "typescriptreact", ".mts": "typescript", ".cts": "typescript", ".js": "javascript", ".jsx": "javascriptreact", ".mjs": "javascript", ".cjs": "javascript" };

export const BUILTIN: ServerDef[] = [
  {
    id: "typescript", label: "TypeScript", extensions: TS,
    roots: ["tsconfig.json", "jsconfig.json", "package.json"],
    command: [
      // TypeScript 7: the compiler is its own language server.
      { path: "@typescript/typescript-*/lib/tsc", args: ["--lsp", "--stdio"], package: "typescript", min: "7.0.0" },
      { bin: "tsgo", args: ["--lsp", "--stdio"] },
      // TypeScript 6 and older: the server loads the project's tsserver and the plugins tsconfig names.
      { bin: "typescript-language-server", args: ["--stdio"], loads: true, optIn: true },
    ],
    // The TypeScript 7 server is a Go program whose memory grows with every
    // edit until its collector runs: collecting at half the default growth
    // kept it a third smaller after twenty edits, at the same time per edit.
    env: { GOGC: "50" },
    auto: true,
    restartOn: ["tsconfig.json", "jsconfig.json", "package.json", "bun.lock", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"],
    runs: "The compiler from the folder's own modules. TypeScript 7 loads no plugin named in tsconfig; typescript-language-server (TypeScript 6 and older) loads them and runs the folder's tsserver.",
  },
  {
    id: "ruff", label: "Ruff (Python lint)", extensions: { ".py": "python", ".pyi": "python" },
    roots: ["pyproject.toml", "ruff.toml", ".ruff.toml"], rootless: true,
    command: [{ bin: "ruff", args: ["server"], dirs: [".venv/bin"] }],
    auto: true,
    restartOn: ["pyproject.toml", "ruff.toml", ".ruff.toml"],
    runs: "It reads the files and its configuration. No code of the folder is known to run.",
  },
  {
    id: "pyright", label: "Pyright (Python types)", extensions: { ".py": "python", ".pyi": "python" },
    roots: ["pyrightconfig.json", "pyproject.toml", "setup.py", "setup.cfg", "requirements.txt"],
    command: [{ bin: "basedpyright-langserver", args: ["--stdio"], dirs: [".venv/bin"], loads: true }, { bin: "pyright-langserver", args: ["--stdio"], dirs: [".venv/bin"], loads: true }],
    auto: false,
    restartOn: ["pyrightconfig.json", "pyproject.toml"],
    runs: "The Python interpreter the project names (its virtual environment's), to ask it for its import paths.",
  },
  {
    id: "gopls", label: "Go", extensions: { ".go": "go" },
    roots: ["go.work", "go.mod"],
    command: [{ bin: "gopls", dirs: ["~/go/bin"], loads: true }],
    initialization: { pullDiagnostics: true },
    auto: false,
    restartOn: ["go.work", "go.mod"],
    runs: "The Go toolchain (go list), which reads go.mod and may download the toolchain and modules it names when the network is on; cgo files run the C preprocessor. It runs no go generate.",
  },
  {
    id: "rust-analyzer", label: "Rust", extensions: { ".rs": "rust" },
    roots: ["Cargo.toml"],
    command: [{ bin: "rust-analyzer", dirs: ["~/.cargo/bin"], loads: true }],
    auto: false,
    restartOn: ["Cargo.toml", "Cargo.lock", "rust-toolchain.toml", "rust-toolchain"],
    runs: "Build scripts and procedural macros of the project and of its dependencies, and cargo check on every save (type errors come from it); .cargo/config and rust-toolchain.toml can name the compiler it runs.",
  },
  {
    id: "clangd", label: "C and C++", extensions: { ".c": "c", ".h": "c", ".cc": "cpp", ".cpp": "cpp", ".cxx": "cpp", ".hpp": "cpp", ".hh": "cpp", ".hxx": "cpp" },
    roots: ["compile_commands.json", "compile_flags.txt", ".clangd"], nearest: true,
    command: [{ bin: "clangd", args: ["--log=error"] }],
    auto: false,
    restartOn: ["compile_commands.json", "compile_flags.txt", ".clangd"],
    runs: "It reads the commands in compile_commands.json. It is not known to run them (a compiler is asked only with --query-driver).",
  },
];

// The owner's entry for a server: any field of a definition, `enabled` to turn
// a found one on or off, and `command` as one argv.
export type ServerOverride = { enabled?: boolean; command?: string[]; extensions?: Record<string, string>; roots?: string[]; env?: Record<string, string>; initialization?: unknown; settings?: unknown; label?: string };

export function checkOverrides(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "object" || Array.isArray(v)) return "servers is an object of server ids";
  for (const [id, o] of Object.entries(v as Record<string, any>)) {
    if (!/^[a-z0-9][a-z0-9_-]{0,40}$/.test(id)) return `a server id is lower-case letters, digits and dashes: ${id}`;
    if (!o || typeof o !== "object" || Array.isArray(o)) return `servers.${id} is an object`;
    for (const k of Object.keys(o)) if (!["enabled", "command", "extensions", "roots", "env", "initialization", "settings", "label"].includes(k)) return `unknown key servers.${id}.${k}`;
    if (o.enabled !== undefined && typeof o.enabled !== "boolean") return `servers.${id}.enabled is true or false`;
    if (o.command !== undefined && !(Array.isArray(o.command) && o.command.length && o.command.every((x: unknown) => typeof x === "string" && x))) return `servers.${id}.command is a list of words, the program first`;
    if (o.extensions !== undefined && !(o.extensions && typeof o.extensions === "object" && Object.entries(o.extensions).every(([e, l]) => /^\.[\w+-]+$/.test(e) && typeof l === "string" && l))) return `servers.${id}.extensions maps an extension (".go") to a language id`;
    if (o.roots !== undefined && !(Array.isArray(o.roots) && o.roots.every((x: unknown) => typeof x === "string" && x && !x.includes("/")))) return `servers.${id}.roots is a list of file names`;
    if (o.env !== undefined && !(o.env && typeof o.env === "object" && Object.values(o.env).every((x) => typeof x === "string"))) return `servers.${id}.env maps names to text`;
    if (!BUILTIN.some((b) => b.id === id) && o.enabled !== false && !(o.command && o.extensions)) return `servers.${id} is not a built-in server: it needs command and extensions`;
  }
  return undefined;
}

// The definitions in force: the built-in ones with the owner's changes, then
// the owner's own. `explicit`: the owner turned it on by name. A command the
// owner wrote is looked for on PATH only (`fixed`), never in the workspace:
// a name in a settings file must not be answered by a file of a repository.
export type Def = ServerDef & { enabled: boolean; own: boolean; explicit: boolean; fixed: boolean };
export function definitions(overrides: Record<string, ServerOverride> = {}): Def[] {
  const merged = (base: ServerDef, o: ServerOverride | undefined, own: boolean): Def => ({
    ...base,
    ...(o?.label ? { label: o.label } : {}),
    ...(o?.extensions ? { extensions: o.extensions } : {}),
    ...(o?.roots ? { roots: o.roots, restartOn: o.roots } : {}),
    // What the owner's program loads is not known: it is taken to load the project's code.
    ...(o?.command ? { command: [{ bin: o.command[0]!, args: o.command.slice(1), loads: true }] } : {}),
    ...(o?.env ? { env: { ...base.env, ...o.env } } : {}),
    ...(o?.initialization !== undefined ? { initialization: o.initialization } : {}),
    ...(o?.settings !== undefined ? { settings: o.settings } : {}),
    enabled: o?.enabled ?? base.auto,
    explicit: o?.enabled === true || own,
    fixed: !!o?.command,
    own,
  });
  const out = BUILTIN.map((b) => merged(b, overrides[b.id], false));
  for (const [id, o] of Object.entries(overrides)) {
    if (BUILTIN.some((b) => b.id === id) || !o.command || !o.extensions) continue;
    // The owner wrote it: it is on unless they turn it off.
    out.push(merged({ id, label: id, extensions: o.extensions, roots: [], rootless: true, command: [], auto: true, restartOn: [], runs: "The command you gave it." }, o, true));
  }
  return out;
}

export const serves = (d: ServerDef, path: string) => Object.hasOwn(d.extensions, extname(path).toLowerCase());
export const languageOf = (d: ServerDef, path: string) => d.extensions[extname(path).toLowerCase()] ?? "plaintext";

// The folders from `from` up to `stop` (both included), innermost first. A
// `from` outside `stop` gives `from` up to its filesystem root's first child.
function ancestors(from: string, stop: string): string[] {
  const out: string[] = [];
  for (let d = from; ; d = dirname(d)) {
    out.push(d);
    if (d === stop || dirname(d) === d) break;
  }
  return out;
}

// The project root of a file for a server, searched no higher than `boundary`
// (the session's workspace when the file is inside it).
export function rootFor(d: ServerDef, file: string, boundary: string): string | null {
  const within = contains(boundary, file);
  const dirs = ancestors(dirname(file), within ? boundary : dirname(file));
  const marked = dirs.filter((dir) => d.roots.some((r) => existsSync(join(dir, r))));
  if (marked.length) return d.nearest ? marked[0]! : marked.at(-1)!;
  return d.rootless ? (within ? boundary : dirname(file)) : null;
}

const versionAtLeast = (have: string, min: string) => {
  const a = have.split(/[.-]/).map(Number), b = min.split(".").map(Number);
  for (let i = 0; i < b.length; i++) { const x = a[i] ?? 0, y = b[i]!; if (Number.isNaN(x)) return false; if (x !== y) return x > y; }
  return true;
};

const isFile = (p: string) => { try { return statSync(p).isFile(); } catch { return false; } };
const home = (p: string) => (p === "~" || p.startsWith("~/") ? join(homeDir(), p.slice(1)) : p);
// A package's version, from a manifest of ordinary size (a file of the workspace is never read whole unseen).
function versionOf(pkg: string): string {
  try {
    if (statSync(pkg).size > 1024 * 1024) return "";
    return String(JSON.parse(readFileSync(pkg, "utf8")).version ?? "");
  } catch { return ""; }
}

// `workspace`: the program is a file of the session's folder or of the
// project (its modules, its virtual environment), where it really lands.
// `loads`: it loads code the project names.
export type Found = { argv: string[]; from: "workspace" | "path"; loads: boolean };
// The command that starts a server for a root, or why there is none. `folder`:
// the session's folder (the workspace's modules are looked for from the root
// up to it, no higher). `path`: the PATH the session's commands get.
export function findCommand(d: Def | (ServerDef & Partial<Pick<Def, "explicit" | "fixed">>), root: string, folder: string, path = process.env.PATH ?? ""): Found | { missing: string } {
  const up = contains(folder, root) ? ancestors(root, folder) : [root];
  const mine = [realOf(root), realOf(folder)];
  const origin = (p: string): "workspace" | "path" => { const r = realOf(p); return mine.some((m) => contains(m, r)) || contains(root, p) || contains(folder, p) ? "workspace" : "path"; };
  const hit = (p: string, c: Candidate): Found => ({ argv: [p, ...(c.args ?? [])], from: origin(p), loads: !!c.loads });
  const tried: string[] = [];
  for (const c of d.command) {
    if (c.optIn && !d.explicit) { tried.push(`${c.bin ?? c.path} (only once you turn this server on)`); continue; }
    const bin = c.bin;
    if (d.fixed) {
      // The owner's own command: a whole path as written, or a name on PATH.
      const p = bin && isAbsolute(bin) ? (isFile(bin) ? bin : null) : bin && !bin.includes("/") ? Bun.which(bin, { PATH: path }) : null;
      if (p) return hit(p, c);
      tried.push(bin && bin.includes("/") && !isAbsolute(bin) ? `${bin} (a command is a name on PATH or a whole path)` : bin ?? "");
      continue;
    }
    if (c.package) {
      const version = up.map((dir) => versionOf(join(dir, "node_modules", c.package!, "package.json"))).find(Boolean) ?? "";
      if (!version || (c.min && !versionAtLeast(version, c.min))) { tried.push(`${c.package}${c.min ? ` ${c.min} or newer` : ""} in the workspace's modules${version ? ` (it has ${version})` : ""}`); continue; }
    }
    if (c.path) {
      let got: string | undefined;
      for (const dir of up) {
        const base = join(dir, "node_modules");
        if (!existsSync(base)) continue;
        const rel = [...new Bun.Glob(c.path).scanSync({ cwd: base, onlyFiles: true, followSymlinks: true })].sort()[0];
        if (rel) { got = join(base, rel); break; }
      }
      if (got) return hit(got, c);
      tried.push(c.path);
      continue;
    }
    if (!bin) continue;
    const local = up.map((dir) => join(dir, "node_modules", ".bin", bin)).find((p) => existsSync(p));
    if (local) return hit(local, c);
    const inDir = (c.dirs ?? []).map((dir) => (dir.startsWith("~") || isAbsolute(dir) ? join(home(dir), bin) : join(root, dir, bin))).find(isFile);
    if (inDir) return hit(inDir, c);
    const onPath = Bun.which(bin, { PATH: path });
    if (onPath) return hit(onPath, c);
    tried.push(bin);
  }
  return { missing: `not found: ${tried.join(", ")}` };
}

// Whether a server may start for a session, and how. A program that is a
// file of the workspace, or that loads the workspace's code, is the
// workspace's program: started by an edit, it would run with no command ever
// allowed. It starts where the session's own commands already run unasked
// (confined in the modes that run sandboxed commands by themselves;
// unconfined only in Full auto with the sandbox off, the owner's choice), or
// in a repository whose language servers the owner trusted in so many words.
// A program of the machine that runs nothing of the workspace starts in any mode.
export type StartFacts = { mode: string; sandbox: "off" | "workspace-write" | "read-only"; trusted: boolean; from: "workspace" | "path"; loads: boolean };
export function startRule(f: StartFacts): { start: "confined" | "unconfined" } | { wait: string } {
  const how = f.sandbox === "off" ? "unconfined" as const : "confined" as const;
  if (f.from === "path" && !f.loads) return { start: how };
  if (f.trusted) return { start: how };
  const what = f.from === "workspace" ? "its program is a file of this folder" : "it loads code this folder names";
  if (f.sandbox !== "off") return ["auto-edits", "auto", "full-auto"].includes(f.mode) ? { start: "confined" } : { wait: `${what}, and this session asks before it runs a command: it starts once you trust this folder's language servers` };
  return f.mode === "full-auto" ? { start: "unconfined" } : { wait: `${what}, and this session's commands run outside a sandbox only when you allow each: it starts once you trust this folder's language servers, or in a sandboxed session` };
}

// What tells a server's configuration apart from the one it started with.
export function configMark(d: ServerDef, root: string): string {
  return d.restartOn.map((f) => { try { const st = statSync(join(root, f)); return `${f}:${st.mtimeMs}:${st.size}`; } catch { return `${f}:-`; } }).join("|");
}
