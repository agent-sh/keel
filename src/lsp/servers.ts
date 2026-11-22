// Which language server serves a file. A server is an entry of data: the
// extensions it reads, the files that mark a project's root, and the commands
// that may start it, looked for in the workspace's own modules and on PATH.
// Nothing is installed: a server whose program is not on the machine is
// listed as not found. The owner's settings add an entry, change one or turn
// one off (`diagnostics.servers`); a built-in one is the same shape.
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, isAbsolute, join } from "node:path";
import { contains } from "../core/paths.ts";

// One way to start the server. `bin`: a program name, looked for in each
// `node_modules/.bin` from the root up, then in `dirs`, then on PATH. `path`:
// a glob under each `node_modules` from the root up (a package's own binary).
// `package`/`min`: only when that package of the workspace is at least that version.
export type Candidate = { bin?: string; path?: string; args?: string[]; package?: string; min?: string; dirs?: string[] };

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
      { bin: "typescript-language-server", args: ["--stdio"] },
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
    command: [{ bin: "basedpyright-langserver", args: ["--stdio"], dirs: [".venv/bin"] }, { bin: "pyright-langserver", args: ["--stdio"], dirs: [".venv/bin"] }],
    auto: false,
    restartOn: ["pyrightconfig.json", "pyproject.toml"],
    runs: "The Python interpreter the project names (its virtual environment's), to ask it for its import paths.",
  },
  {
    id: "gopls", label: "Go", extensions: { ".go": "go" },
    roots: ["go.work", "go.mod"],
    command: [{ bin: "gopls", dirs: ["~/go/bin"] }],
    initialization: { pullDiagnostics: true },
    auto: false,
    restartOn: ["go.work", "go.mod"],
    runs: "The Go toolchain (go list), which reads go.mod and may download the toolchain and modules it names when the network is on; cgo files run the C preprocessor. It runs no go generate.",
  },
  {
    id: "rust-analyzer", label: "Rust", extensions: { ".rs": "rust" },
    roots: ["Cargo.toml"],
    command: [{ bin: "rust-analyzer", dirs: ["~/.cargo/bin"] }],
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

// The definitions in force: the built-in ones with the owner's changes, then the owner's own.
export function definitions(overrides: Record<string, ServerOverride> = {}): (ServerDef & { enabled: boolean; own: boolean })[] {
  const merged = (base: ServerDef, o: ServerOverride | undefined, own: boolean) => ({
    ...base,
    ...(o?.label ? { label: o.label } : {}),
    ...(o?.extensions ? { extensions: o.extensions } : {}),
    ...(o?.roots ? { roots: o.roots, restartOn: o.roots } : {}),
    ...(o?.command ? { command: [{ bin: o.command[0]!, args: o.command.slice(1) }] } : {}),
    ...(o?.env ? { env: { ...base.env, ...o.env } } : {}),
    ...(o?.initialization !== undefined ? { initialization: o.initialization } : {}),
    ...(o?.settings !== undefined ? { settings: o.settings } : {}),
    enabled: o?.enabled ?? base.auto,
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
const home = (p: string) => (p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p);

export type Found = { argv: string[]; from: "workspace" | "path" };
// The command that starts a server for a root, or why there is none. `path`:
// the PATH the session's commands get.
export function findCommand(d: ServerDef, root: string, path = process.env.PATH ?? ""): Found | { missing: string } {
  const up = ancestors(root, "/").slice(0, 12);
  const tried: string[] = [];
  for (const c of d.command) {
    if (c.package) {
      const pkg = up.map((dir) => join(dir, "node_modules", c.package!, "package.json")).find(isFile);
      let version = "";
      try { version = pkg ? String(JSON.parse(readFileSync(pkg, "utf8")).version ?? "") : ""; } catch {}
      if (!version || (c.min && !versionAtLeast(version, c.min))) { tried.push(`${c.package}${c.min ? ` ${c.min} or newer` : ""} in the workspace's modules${version ? ` (it has ${version})` : ""}`); continue; }
    }
    if (c.path) {
      for (const dir of up) {
        const base = join(dir, "node_modules");
        if (!existsSync(base)) continue;
        const hit = [...new Bun.Glob(c.path).scanSync({ cwd: base, onlyFiles: true, followSymlinks: true })].sort()[0];
        if (hit) return { argv: [join(base, hit), ...(c.args ?? [])], from: "workspace" };
      }
      tried.push(c.path);
      continue;
    }
    const bin = c.bin!;
    if (isAbsolute(bin)) { if (isFile(bin)) return { argv: [bin, ...(c.args ?? [])], from: "path" }; tried.push(bin); continue; }
    const local = up.map((dir) => join(dir, "node_modules", ".bin", bin)).find((p) => existsSync(p));
    if (local) return { argv: [local, ...(c.args ?? [])], from: "workspace" };
    const inDir = (c.dirs ?? []).map((dir) => (dir.startsWith("~") || isAbsolute(dir) ? join(home(dir), bin) : join(root, dir, bin))).find(isFile);
    if (inDir) return { argv: [inDir, ...(c.args ?? [])], from: inDir.startsWith(root + "/") ? "workspace" : "path" };
    const onPath = Bun.which(bin, { PATH: path });
    if (onPath) return { argv: [onPath, ...(c.args ?? [])], from: "path" };
    tried.push(bin);
  }
  return { missing: `not found: ${tried.join(", ")}` };
}

// What tells a server's configuration apart from the one it started with.
export function configMark(d: ServerDef, root: string): string {
  return d.restartOn.map((f) => { try { const st = statSync(join(root, f)); return `${f}:${st.mtimeMs}:${st.size}`; } catch { return `${f}:-`; } }).join("|");
}
