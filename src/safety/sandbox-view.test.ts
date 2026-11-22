// What a confined command can read, against a home made for the test: its
// toolchains run, its secrets are not there, what it writes in its home stays
// the sandbox's own, and Keel's own folders are never shown.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gitViewsDir, setGitViews } from "../core/git.ts";
import { configDir } from "../providers/config.ts";
import { refusedRead, sandboxConfig, setSandboxConfig } from "./sandbox-config.ts";
import { confine, forgetProfiles, sandboxStatus, setProfileAge, setSlotWait } from "./sandbox.ts";
import { sandboxScope, scopeDir } from "./sandbox-scope.ts";
import { envDropped, envPlan, hiddenSaid, overlays, readView, registrySettings, shownPaths, shownTo, siblings, tendSandboxes, toolchainPaths } from "./sandbox-view.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "keel-view-")));
const home = join(root, "home"), ws = join(root, "ws");
const was = { HOME: process.env.HOME, PATH: process.env.PATH, SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK, TMPDIR: process.env.TMPDIR, KEEL_CONFIG_DIR: process.env.KEEL_CONFIG_DIR };
// Keel's own folders, where an owner's are: in the home.
const stateWas = dirname(gitViewsDir());
const put = (rel: string, text = "x\n", mode?: number) => { mkdirSync(dirname(join(home, rel)), { recursive: true }); writeFileSync(join(home, rel), text, mode ? { mode } : undefined); };
const tool = (rel: string, says: string) => { put(rel, `#!/bin/sh\necho ${says}\n`); chmodSync(join(home, rel), 0o755); };
const state = () => dirname(gitViewsDir());

beforeAll(() => {
  mkdirSync(ws, { recursive: true });
  // The owner's secrets, at well-known names and at names no list has.
  for (const f of [".ssh/id_ed25519", ".aws/credentials", ".netrc", ".bash_history", ".bashrc", ".config/gh/hosts.yml", ".some-cloud_api_key", "projects/other/.env", ".cargo/credentials.toml", "notes/plan.md"]) put(f, "SECRET\n");
  // Toolchains: one at a well-known name, one at a place of its own on PATH (with its library beside it),
  // and one that a link in a PATH folder points at.
  tool(".cargo/bin/cargo-here", "cargo-ran");
  tool("tools/zzz/bin/zzz", '"zzz-ran $(cat "$(dirname "$0")/../lib/data")"');
  put("tools/zzz/lib/data", "with-its-lib\n");
  tool("apps/app/bin/run", "app-ran");
  put("apps/app/share/x", "x\n");
  mkdirSync(join(home, ".local/bin"), { recursive: true });
  symlinkSync(join(home, "apps/app/bin/run"), join(home, ".local/bin/app"));
  // A Go workspace on PATH: its bin is a toolchain, its module cache is not.
  tool("go/bin/gotool", "gotool-ran");
  put("go/pkg/mod/cache/x", "cached\n");
  put(".cargo/registry/idx-real", "real-index\n");
  put(".cache/uv/wheel", "real-wheel\n");
  put(".cache/other-work/notes", "SECRET\n");
  put(".gitconfig", "[user]\n\tname = The Owner\n\temail = o@o\n[core]\n\texcludesFile = ~/.ignore_global\n");
  put(".ignore_global", "*.swp\n");
  process.env.HOME = home;
  setGitViews(join(home, ".local/share/keel-bun/state"));
  process.env.KEEL_CONFIG_DIR = join(home, ".config/keel-bun");
  mkdirSync(join(state(), "spill"), { recursive: true });
  writeFileSync(join(state(), "api-token"), "TOKEN\n");
  mkdirSync(join(configDir(), "skills/x"), { recursive: true });
  writeFileSync(join(configDir(), "mcp.json"), "{}\n");
  writeFileSync(join(configDir(), "skills/x/run.sh"), "echo skill-ran\n");
  process.env.PATH = `${join(home, "tools/zzz/bin")}:${join(home, ".cargo/bin")}:${join(home, ".local/bin")}:${join(home, "go/bin")}:/usr/local/bin:/usr/bin:/bin`;
  process.env.TMPDIR = join(home, ".cache/tmp");
  mkdirSync(process.env.TMPDIR, { recursive: true });
  delete process.env.SSH_AUTH_SOCK;
});
afterAll(() => {
  for (const [k, v] of Object.entries(was)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  setGitViews(stateWas);
  // (A module cache keeps its folders read-only.)
  Bun.spawnSync(["chmod", "-R", "u+rwX", root], { stdout: "ignore", stderr: "ignore" });
  rmSync(root, { recursive: true, force: true });
});

const run = (script: string, o: { sandbox?: "workspace-write" | "read-only"; at?: string; read?: string[]; sshAgent?: boolean; env?: Record<string, string>; keep?: string[]; worktrees?: string[] } = {}) => {
  const at = o.at ?? ws;
  // (Each command of a test reads the disk as it is now.)
  forgetProfiles();
  const r = Bun.spawnSync(confine(["bash", "-c", script], { sandbox: o.sandbox ?? "workspace-write", network: false }, at, undefined, { read: o.read, sshAgent: o.sshAgent, env: o.keep, worktrees: o.worktrees }), {
    cwd: at, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", ...o.env } as Record<string, string>,
  });
  return (r.stdout.toString() + r.stderr.toString()).replaceAll(home, "~");
};
// Whether each path can be read (never what it holds).
const can = (paths: string[]) => `for p in ${paths.join(" ")}; do if [ -r "$p" ]; then echo "$p yes"; else echo "$p no"; fi; done`;


test("the toolchains of a home are found: well-known names, PATH folders with their roots, what links point at, and git's own files", () => {
  // (The toolchain variables of the machine the test runs on are left out: a toolchain outside this home is shown too.)
  const shown = toolchainPaths(home, { PATH: process.env.PATH }).map((p) => p.replace(`${home}/`, ""));
  expect(shown).toEqual([".cargo/bin", ".gitconfig", ".ignore_global", ".local/bin", "apps/app", "go/bin", "tools/zzz"]);
});

test.skipIf(!sandboxStatus().available)("a confined command runs the owner's toolchains and reads none of the owner's secrets", () => {
  expect(run("zzz; cargo-here; app; gotool; git config user.name")).toBe("zzz-ran with-its-lib\ncargo-ran\napp-ran\ngotool-ran\nThe Owner\n");
  const secrets = ["~/.ssh/id_ed25519", "~/.aws/credentials", "~/.netrc", "~/.bash_history", "~/.bashrc", "~/.config/gh/hosts.yml", "~/.some-cloud_api_key", "~/projects/other/.env", "~/.cargo/credentials.toml", "~/notes/plan.md", "~/.cache/other-work/notes"];
  expect(run(can(secrets))).toBe(secrets.map((p) => `${p} no\n`).join(""));
  // Nothing of the real home is listed but what was bound, and the runtime sockets, other homes and mounted disks are not there.
  // (Beside these, a tool installed on this machine's system folders gets its own empty folder for a first use: left out here.)
  const firstUse = "\\.bun|\\.gradle|\\.m2|\\.nuget|\\.pub-cache|\\.hex|\\.cabal|\\.stack|\\.julia|\\.conda|\\.deno|\\.yarn|\\.bundle|\\.ccache";
  expect(run(`ls -A ~ | LC_ALL=C sort | grep -v -x -E '${firstUse}' | tr '\\n' ' '; echo; ls -A /run /mnt /media /root 2>/dev/null | grep -c -E 'sock|bus' ; echo "$DBUS_SESSION_BUS_ADDRESS|$SSH_AUTH_SOCK|$DISPLAY"`, { env: { DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/0/bus", DISPLAY: ":0" } }))
    .toBe(".cache .cargo .config .gitconfig .ignore_global .keel-sandbox .local .npm .profile .zprofile apps go tools \n0\n||\n");
  // The package caches are the owner's, read: what was fetched before builds with the network off. Nothing else of those folders is.
  expect(run("cat ~/go/pkg/mod/cache/x ~/.cargo/registry/idx-real \"$XDG_CACHE_HOME/uv/wheel\" ~/.cache/uv/wheel; ls -A ~/.cache | tr '\\n' ' '")).toBe("cached\nreal-index\nreal-wheel\nreal-wheel\ntmp uv ");
  // Keel's own state and config folders: not there, but for the skills it offers a session, which run where its commands run.
  expect(run(`${can([join(state(), "api-token"), join(configDir(), "mcp.json")])}; ls -A ${state()} ${configDir()} 2>/dev/null | grep -v : | tr '\\n' ' '; sh ${join(configDir(), "skills/x/run.sh")}`))
    .toBe(`${join(state(), "api-token").replace(home, "~")} no\n${join(configDir(), "mcp.json").replace(home, "~")} no\nskills skill-ran\n`);
  // The home is in memory and holds no leftovers: a file of a store that one command's view named is not an empty file in the next.
  expect(run("ls -A ~/.aws ~/.ssh 2>&1 | grep -c 'No such file'")).toBe("2\n");
});

test.skipIf(!sandboxStatus().available)("the sandbox's home is read-only but for its own cache folders: what a tool fetches stays for the next command and never reaches the real home", () => {
  // A package manager's cache (where the XDG variable says) and log (at its own default place); the temp folder too.
  expect(run("mkdir -p \"$XDG_CACHE_HOME/pm\" ~/.npm/_logs && echo fetched > \"$XDG_CACHE_HOME/pm/pkg\" && echo log > ~/.npm/_logs/1 && mktemp >/dev/null && echo \"wrote in ${XDG_CACHE_HOME#$HOME/} and ${XDG_STATE_HOME#$HOME/}\"")).toBe("wrote in .keel-sandbox/cache and .keel-sandbox/state\n");
  expect(run("cat ~/.keel-sandbox/cache/pm/pkg; ls \"$TMPDIR\" | wc -l")).toBe("fetched\n1\n");
  expect([existsSync(join(home, ".keel-sandbox")), existsSync(join(home, ".npm")), existsSync(join(home, ".cache/tmp/pm"))]).toEqual([false, false, false]);
  // The caches are copy-on-write: a command adds to the Go module cache and cargo's registry and changes a file there, the next
  // command finds that, and the owner's real cache holds none of it.
  expect(run("echo m > ~/go/pkg/mod-x && echo r > ~/.cargo/registry/idx && echo changed > ~/.cargo/registry/idx-real && echo w > \"$XDG_CACHE_HOME/uv/new\" && echo wrote")).toBe("wrote\n");
  expect(run("cat ~/go/pkg/mod-x ~/.cargo/registry/idx ~/.cargo/registry/idx-real ~/go/pkg/mod/cache/x ~/.cache/uv/new")).toBe("m\nr\nchanged\ncached\nw\n");
  expect([existsSync(join(home, "go/pkg/mod-x")), existsSync(join(home, ".cargo/registry/idx")), readFileSync(join(home, ".cargo/registry/idx-real"), "utf8"), existsSync(join(home, ".cache/uv/new"))]).toEqual([false, false, "real-index\n", false]);
  // A file the owner fetched after that shows up in the sandbox at once.
  put("go/pkg/mod/cache/later", "later\n");
  expect(run("cat ~/go/pkg/mod/cache/later")).toBe("later\n");
  // Anywhere else in the home a write fails, as a write outside the session's folder always did.
  // (`~/.cache` too: people keep work there, and a file a command made there would be in a copy the file tools never see.)
  expect(run("(echo x > ~/note) 2>&1 | grep -c 'Read-only'; (mkdir ~/projects) 2>&1 | grep -c 'Read-only'; (echo x > ~/.config/tool.toml) 2>&1 | grep -c -E 'Read-only|No such file'; (mkdir ~/.cache/task-x) 2>&1 | grep -c 'Read-only'")).toBe("1\n1\n1\n1\n");
  // The owner's toolchains and settings are read-only there: a command cannot change what runs outside later.
  expect(run("(echo x >> ~/.cargo/bin/cargo-here) 2>&1 | grep -c 'Read-only'; (echo x >> ~/.gitconfig) 2>&1 | grep -c 'Read-only'; (echo x > ~/tools/zzz/bin/new) 2>&1 | grep -c 'Read-only'")).toBe("1\n1\n1\n");
  // A login shell finds the toolchains through the profile of the sandbox's home.
  expect(run("bash -lc 'command -v zzz cargo-here >/dev/null && echo found'", { env: { PATH: process.env.PATH! } })).toContain("found");
  // Read-only: the same view, and nothing is written, the home and the caches included.
  expect(run("zzz; (echo x > ~/y) 2>&1 | grep -c Read-only; (echo x > ./y) 2>&1 | grep -c Read-only; (echo x > \"$XDG_CACHE_HOME/y\") 2>&1 | grep -c Read-only; (echo x > ~/go/pkg/y) 2>&1 | grep -c Read-only; cat \"$XDG_CACHE_HOME/pm/pkg\" ~/go/pkg/mod-x ~/go/pkg/mod/cache/x", { sandbox: "read-only" }))
    .toBe("zzz-ran with-its-lib\n1\n1\n1\n1\nfetched\nm\ncached\n");
});

test.skipIf(!sandboxStatus().available || !overlays())("commands at once each take a cache layer of their own, and each reads the owner's cache", async () => {
  // Eight at once: each writes its own name into the Go cache and reads the owner's file; none sees another's while it runs.
  const spawn = (i: number) => {
    forgetProfiles();
    const p = Bun.spawn(confine(["bash", "-c", `echo ${i} > ~/go/pkg/from-${i}; sleep 0.6; cat ~/go/pkg/mod/cache/x; ls ~/go/pkg | grep -c '^from-'`], { sandbox: "workspace-write", network: false }, ws), { cwd: ws, stdout: "pipe", stderr: "pipe", env: process.env as Record<string, string> });
    return new Response(p.stdout).text();
  };
  const outs = await Promise.all([1, 2, 3, 4, 5, 6, 7, 8].map(spawn));
  // (The first slot holds what an earlier test's command wrote: one more name there is not another command's of this test.)
  for (const out of outs) expect(out).toBe("cached\n1\n");
  // None of it is in the owner's cache, and the next command alone finds the first slot's.
  expect(existsSync(join(home, "go/pkg/from-1"))).toBe(false);
  expect(run("ls ~/go/pkg | grep -c '^from-'")).toBe("1\n");
});

test.skipIf(!sandboxStatus().available || !overlays())("what tends the sandboxes follows no link a command left, and a command runs after it cleared everything", async () => {
  // A command leaves, in its temp folder and its cache layer, links to a folder of the owner's and to the home.
  const precious = join(home, "precious");
  mkdirSync(join(precious, "sub"), { recursive: true });
  writeFileSync(join(precious, "sub/keep.txt"), "keep\n");
  writeFileSync(join(precious, "ro.txt"), "ro\n");
  chmodSync(join(precious, "ro.txt"), 0o400);
  chmodSync(join(precious, "sub"), 0o500);
  try {
    const left = run(`ln -sfn ${precious} "$TMPDIR/link-out"; ln -sfn ${home} "$TMPDIR/link-home"; mkdir -p "$TMPDIR/d/deep"; ln -sfn ${precious} "$TMPDIR/d/inner"; ln -sfn ${precious} ~/go/pkg/link-in-layer; echo x > "$TMPDIR/d/deep/f"; chmod 500 "$TMPDIR/d/deep"; echo left`);
    expect(left).toBe("left\n");
    const scope = scopeDir(sandboxScope(ws));
    expect(existsSync(join(scope, "tmp"))).toBe(true);
    const homeBefore = readdirSync(home).sort();
    await tendSandboxes(true);
    // Nothing of the owner's was touched: not a mode, not a file.
    expect((statSync(join(precious, "ro.txt")).mode & 0o777).toString(8)).toBe("400");
    expect((statSync(join(precious, "sub")).mode & 0o777).toString(8)).toBe("500");
    expect(readFileSync(join(precious, "sub/keep.txt"), "utf8")).toBe("keep\n");
    expect(readdirSync(home).sort()).toEqual(homeBefore);
    // What the command left is gone, links and read-only folders alike, and so are the layers.
    expect(readdirSync(join(scope, "tmp"))).toEqual([]);
    expect(existsSync(join(scope, "up", "0"))).toBe(false);
    expect(readdirSync(join(dirname(scope), "trash"))).toEqual([]);
    // The next commands of the repository run: the layer's folders are made again at their start.
    expect(run("echo ran; ls ~/go/pkg | grep -c link-in-layer")).toBe("ran\n0\n");
    expect(run("echo again > ~/go/pkg/after-clear; cat ~/go/pkg/after-clear")).toBe("again\n");
    // Also when only the folders went (removed by hand) and the slot's own files stayed.
    for (const d of ["up", "work"]) { Bun.spawnSync(["chmod", "-R", "u+rwX", join(scope, d)]); rmSync(join(scope, d), { recursive: true, force: true }); }
    expect(run("echo ran")).toBe("ran\n");
  } finally {
    chmodSync(join(precious, "sub"), 0o700);
    rmSync(precious, { recursive: true, force: true });
  }
});

test.skipIf(!sandboxStatus().available || !overlays())("one session holds a share of a repository's cache layers, and a command past it ends with the sentence", async () => {
  setSlotWait(1);
  const start = (script: string, session?: string) => {
    forgetProfiles();
    return Bun.spawn(confine(["bash", "-c", script], { sandbox: "workspace-write", network: false }, ws), { cwd: ws, stdout: "pipe", stderr: "pipe", env: { ...process.env, ...(session ? { KEEL_SESSION: session } : {}) } as Record<string, string> });
  };
  const held = Array.from({ length: 16 }, () => start("echo up; sleep 30", "session-a"));
  try {
    // (Each has its layer when it has said so.)
    await Promise.all(held.map(async (p) => { const r = p.stdout.getReader(); await r.read(); r.releaseLock(); }));
    const over = start("echo ran", "session-a");
    const [out, err] = await Promise.all([new Response(over.stdout).text(), new Response(over.stderr).text()]);
    expect([await over.exited, out]).toEqual([75, ""]);
    expect(err).toContain("this session already runs 16 sandboxed commands at once");
    // Another session of the repository, and a command of no session, are not held up by it.
    const other = start("echo ran", "session-b");
    expect([await new Response(other.stdout).text(), await other.exited]).toEqual(["ran\n", 0]);
    const none = start("echo ran");
    expect([await new Response(none.stdout).text(), await none.exited]).toEqual(["ran\n", 0]);
  } finally {
    for (const p of held) p.kill();
    await Promise.all(held.map((p) => p.exited));
    setSlotWait(20);
  }
}, 60_000);

test.skipIf(!sandboxStatus().available)("a first use of a package manager: a cache the owner has none of is the sandbox's own folder, the tool's whole folder when that is not there", () => {
  // No ~/.m2 at all: the whole folder is the sandbox's. A ~/.gradle with no caches yet: the caches folder is.
  mkdirSync(join(home, ".gradle"), { recursive: true });
  // (The tools are installed: their programs are on PATH.)
  tool("tools/zzz/bin/mvn", "mvn");
  expect(run("mkdir -p ~/.m2/repository/x && echo j > ~/.m2/repository/x/a.jar && echo lock > ~/.m2/.lock && mkdir -p ~/.gradle/caches/y && echo g > ~/.gradle/caches/y/b && echo wrote")).toBe("wrote\n");
  expect(run("cat ~/.m2/repository/x/a.jar ~/.m2/.lock ~/.gradle/caches/y/b; (echo x > ~/.gradle/gradle.properties) 2>&1 | grep -c Read-only")).toBe("j\nlock\ng\n1\n");
  expect([existsSync(join(home, ".m2")), existsSync(join(home, ".gradle/caches"))]).toEqual([false, false]);
});

test.skipIf(!sandboxStatus().available)("nothing is followed from a folder the sandbox writes: links planted in a PATH folder of the workspace reach nothing", () => {
  // An activated environment: a folder of the workspace on the daemon's PATH. A sandboxed command plants links there.
  const venv = join(ws, ".venv/bin");
  mkdirSync(venv, { recursive: true });
  const path = process.env.PATH;
  process.env.PATH = `${venv}:${path}`;
  try {
    const targets = [join(home, ".ssh/id_ed25519"), join(home, ".aws/credentials"), join(state(), "api-token"), join(configDir(), "mcp.json"), join(home, ".config/gh/hosts.yml"), join(home, "projects/other/.env"), join(home, "notes")];
    expect(run(targets.map((t, i) => `ln -sf ${t} .venv/bin/l${i}`).join("; ") + "; echo planted")).toBe("planted\n");
    expect(run(targets.map((_t, i) => `cat .venv/bin/l${i} 2>&1 | grep -c 'No such file'`).join("; "))).toBe("1\n".repeat(targets.length));
    // The same for a toolchain variable that names a folder of the workspace.
    process.env.VIRTUAL_ENV = join(ws, ".venv");
    expect(run("cat .venv/bin/l0 2>&1 | grep -c 'No such file'")).toBe("1\n");
  } finally {
    process.env.PATH = path;
    delete process.env.VIRTUAL_ENV;
    rmSync(join(ws, ".venv"), { recursive: true, force: true });
  }
});

test.skipIf(!sandboxStatus().available)("nothing in a store is bound, whatever names it: a link in a PATH folder, a toolchain folder with a sign-in beside its programs, a toolchain variable, git's config", () => {
  const path = process.env.PATH;
  try {
    // Links in a PATH folder of the home to a key, a credentials file and Keel's token (an earlier step outside the sandbox made them).
    symlinkSync(join(home, ".ssh/id_ed25519"), join(home, ".local/bin/key"));
    symlinkSync(join(home, ".aws"), join(home, ".local/bin/aws-folder"));
    symlinkSync(join(state(), "api-token"), join(home, ".local/bin/token"));
    // A tool's dot-folder directly in the home: programs, a library, and its sign-in file.
    tool(".tool/bin/thetool", '"thetool-ran $(cat "$(dirname "$0")/../lib/d")"');
    put(".tool/lib/d", "lib\n");
    put(".tool/signin.json", "SECRET\n");
    // A toolchain variable whose folder holds credentials, and git's config naming a token file as its attributes.
    put(".gem/credentials", "SECRET\n");
    put(".gem/specs/x", "spec\n");
    put(".vault-token", "SECRET\n");
    writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = The Owner\n[core]\n\tattributesFile = ~/.vault-token\n");
    process.env.PATH = `${join(home, ".tool/bin")}:${path}`;
    process.env.GEM_HOME = join(home, ".gem");
    const out = run(`thetool; cat ~/.gem/specs/x; ${can(["~/.local/bin/key", "~/.local/bin/aws-folder/credentials", "~/.local/bin/token", "~/.ssh/id_ed25519", "~/.aws/credentials", "~/.tool/signin.json", "~/.gem/credentials", "~/.vault-token"])}`);
    expect(out).toBe("thetool-ran lib\nspec\n" + ["~/.local/bin/key", "~/.local/bin/aws-folder/credentials", "~/.local/bin/token", "~/.ssh/id_ed25519", "~/.aws/credentials", "~/.tool/signin.json", "~/.gem/credentials", "~/.vault-token"].map((p) => `${p} no\n`).join(""));
  } finally {
    process.env.PATH = path;
    delete process.env.GEM_HOME;
    for (const f of ["key", "aws-folder", "token"]) rmSync(join(home, ".local/bin", f), { force: true });
    put(".gitconfig", "[user]\n\tname = The Owner\n\temail = o@o\n[core]\n\texcludesFile = ~/.ignore_global\n");
  }
});

test.skipIf(!sandboxStatus().available)("a sandboxed command's environment holds what a build needs and no token of the daemon's", () => {
  const planted: Record<string, string> = {
    GITHUB_TOKEN: "KEELMARK-t", GH_TOKEN: "KEELMARK-t", NPM_TOKEN: "KEELMARK-t", HF_TOKEN: "KEELMARK-t", CLOUDFLARE_API_TOKEN: "KEELMARK-t", AWS_SECRET_ACCESS_KEY: "KEELMARK-t", DATABASE_URL: "postgres://u:KEELMARK-pw@db/x",
    KEEL_ANYTHING: "KEELMARK-k", SOME_APP_SETTING: "KEELMARK-v", MY_BUILD_FLAG: "on",
    // A registry or proxy setting with a sign-in in its URL (a password, or a token alone) is kept without the sign-in.
    GOPROXY: "https://user:KEELMARK-pw@proxy.example,direct", PIP_INDEX_URL: "https://KEELMARK-token@pypi.example/simple",
    // git settings given through the environment, one of them an Authorization header: all of them go.
    GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "http.extraheader", GIT_CONFIG_VALUE_0: "Authorization: Bearer KEELMARK-git", GIT_CONFIG_KEY_1: "core.quotepath", GIT_CONFIG_VALUE_1: "off",
  };
  for (const [k, v] of Object.entries(planted)) process.env[k] = v;
  try {
    const names = (out: string) => out.trim().split("\n").filter(Boolean).sort();
    // (The sandbox gives git settings of its own under the same names: those are looked at by their values below.)
    const got = names(run(`env | cut -d= -f1 | grep -E '^(${Object.keys(planted).filter((k) => !/^GIT_CONFIG_(KEY|VALUE)/.test(k)).join("|")}|PATH|HOME|LANG|TMPDIR|XDG_CACHE_HOME)$'`, { env: planted }));
    expect(got).toEqual(["GIT_CONFIG_COUNT", "GOPROXY", "HOME", ...(process.env.LANG ? ["LANG"] : []), "PATH", "PIP_INDEX_URL", "TMPDIR", "XDG_CACHE_HOME"]);
    expect(run(`echo "$GOPROXY $PIP_INDEX_URL"; git config --get http.extraheader; git config --get core.quotepath; echo "git settings: $GIT_CONFIG_COUNT"`, { env: planted }).trim().split("\n")[0]).toBe("https://proxy.example,direct https://pypi.example/simple");
    // Nothing of it anywhere inside: not in the command's environment, and not in the environment any process there
    // was started with (bubblewrap is the first one, and it is started clean).
    const seen = run(`echo "own: $(env | grep -c KEELMARK)"; for p in /proc/[0-9]*; do echo "$(cat $p/comm): $(tr '\\0' '\\n' < $p/environ | grep -c KEELMARK)"; done`, { env: planted });
    expect(seen).toContain("bwrap: 0");
    expect(seen.trim().split("\n").filter((l) => !/: 0$/.test(l))).toEqual([]);
    // A name the owner keeps, in Settings.
    expect(names(run("env | cut -d= -f1 | grep -E '^(MY_BUILD_FLAG|GITHUB_TOKEN)$'", { env: planted, keep: ["MY_BUILD_FLAG"] }))).toEqual(["MY_BUILD_FLAG"]);
    // The rule itself: by name, and by a value that holds a password.
    expect(envDropped({ PATH: "/bin", GOPATH: "/g", CARGO_HOME: "/c", LC_ALL: "C", GIT_SSH_COMMAND: "ssh", SSH_AUTH_SOCK: "/s", KEEL_SESSION: "x", FOO: "1", GH_TOKEN: "t", CARGO_REGISTRY_TOKEN: "t", UV_INDEX_URL: "https://u:p@x/simple", PIP_INDEX_URL: "https://x/simple", GIT_ASKPASS: "a", API_KEY: "k", MONKEY: "banana" }))
      .toEqual(["FOO", "GH_TOKEN", "CARGO_REGISTRY_TOKEN", "API_KEY", "MONKEY"]);
    expect(envPlan({ UV_INDEX_URL: "https://u:p@x/simple", GOPROXY: "https://tok@a.example,https://b.example", PIP_INDEX_URL: "https://x/simple", PATH: "/bin" }).set).toEqual([["UV_INDEX_URL", "https://x/simple"], ["GOPROXY", "https://a.example,https://b.example"]]);
    // A value that carries a sign-in under a kept name goes whole: a header, a token in a URL's query, a netrc
    // line, a field of JSON, a flag that sets one.
    const carried = { PIP_EXTRA_INDEX_URL: "https://pip.example/simple?token=abc123", CARGO_HTTP_USER_AGENT: "Authorization: Bearer abcdef123456", LESS: "machine x login y password zzz", XDG_CONFIG_JSON: '{"token":"abc"}', GOFLAGS: "-ldflags=-X=main.token=abc", NODE_OPTIONS: "--require ./x.js --api-key=abc", UV_INDEX: "https://x/simple?a=1&access_token=abc" };
    expect(envPlan({ ...carried, PATH: "/bin", LANG: "C" }).drop.sort()).toEqual(Object.keys(carried).sort());
    // What a build sets every day stays.
    const plain = { PATH: "/usr/bin:/bin", GOFLAGS: "-mod=mod -tags=netgo", LESS: "-R -F", NODE_OPTIONS: "--max-old-space-size=4096", CARGO_TERM_COLOR: "always", PIP_INDEX_URL: "https://pypi.org/simple", MAKEFLAGS: "-j8", LDFLAGS: "-L/usr/local/lib -Wl,-rpath=/x", CMAKE_PREFIX_PATH: "/opt/key=value", GIT_SSH_COMMAND: "ssh -o BatchMode=yes" };
    expect(envPlan(plain)).toEqual({ drop: [], set: [] });
    // git's settings stay when none carries a sign-in.
    expect(envPlan({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.quotepath", GIT_CONFIG_VALUE_0: "off" }).drop).toEqual([]);
    expect(envPlan({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "url.https://tok@github.com/.insteadof", GIT_CONFIG_VALUE_0: "https://github.com/" }).drop).toEqual(["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"]);
  } finally {
    for (const k of Object.keys(planted)) delete process.env[k];
  }
});

test.skipIf(!sandboxStatus().available)("the package managers' registry settings are passed on without their tokens", () => {
  put(".npmrc", "registry=https://user:pw@npm.corp.example/\n@corp:registry=https://npm.corp.example/corp/\n//npm.corp.example/:_authToken=SECRET-TOKEN\nemail=o@o\n");
  put(".config/pip/pip.conf", "[global]\nindex-url = https://user:SECRET-PW@pypi.corp.example/simple\ncert = /x\n");
  put(".bunfig.toml", '[install]\nregistry = { url = "https://npm.corp.example/", token = "SECRET-TOKEN" }\n[install.scopes]\n"@corp" = { token = "SECRET-TOKEN", url = "https://npm.corp.example/corp/" }\n');
  try {
    expect(run("cat ~/.npmrc")).toBe("registry=https://npm.corp.example/\n@corp:registry=https://npm.corp.example/corp/\n");
    expect(run("cat ~/.config/pip/pip.conf")).toBe("[global]\nindex-url = https://pypi.corp.example/simple\n");
    expect(run("cat ~/.bunfig.toml")).toBe('[install]\nregistry = "https://npm.corp.example/"\n[install.scopes]\n"@corp" = "https://npm.corp.example/corp/"\n');
    expect(run("cat ~/.npmrc ~/.config/pip/pip.conf ~/.bunfig.toml | grep -c SECRET; (echo x >> ~/.npmrc) 2>&1 | grep -c Read-only")).toBe("0\n1\n");
    expect(registrySettings(home).map(([, at]) => at.replace(home, "~"))).toEqual(["~/.npmrc", "~/.config/pip/pip.conf", "~/.bunfig.toml"]);
  } finally {
    for (const f of [".npmrc", ".config/pip/pip.conf", ".bunfig.toml"]) rmSync(join(home, f), { force: true });
  }
});

test.skipIf(!sandboxStatus().available)("the owner's list opens a folder for a workspace; the credential stores and Keel's own folders stay hidden whatever is bound", () => {
  expect(run(can(["~/projects/other/.env", "~/notes/plan.md"]), { read: ["~/projects", join(home, "notes")] })).toBe("~/projects/other/.env yes\n~/notes/plan.md yes\n");
  // A list that names the whole home (the settings refuse it; the view holds anyway): the stores are hidden in it, and Keel's own folders.
  const all = run(can(["~/notes/plan.md", "~/.some-cloud_api_key", "~/.ssh/id_ed25519", "~/.aws/credentials", "~/.netrc", "~/.bashrc", "~/.cargo/credentials.toml", join(state(), "api-token"), join(configDir(), "mcp.json")]), { read: [home] });
  expect(all).toBe(["~/notes/plan.md yes", "~/.some-cloud_api_key yes", "~/.ssh/id_ed25519 no", "~/.aws/credentials no", "~/.netrc no", "~/.bashrc no", "~/.cargo/credentials.toml no", `${join(state(), "api-token").replace(home, "~")} no`, `${join(configDir(), "mcp.json").replace(home, "~")} no`, ""].join("\n"));
  // An entry that is a link is there under its own name and where it points.
  symlinkSync(join(home, "notes"), join(root, "link-to-notes"));
  expect(run(`cat ${join(root, "link-to-notes/plan.md")} ~/notes/plan.md`, { read: [join(root, "link-to-notes")] })).toBe("SECRET\nSECRET\n");
  // A store the list names is the owner's choice; an entry in Keel's own folders is never taken.
  expect(run(can(["~/.ssh/id_ed25519"]), { read: ["~/.ssh"] })).toBe("~/.ssh/id_ed25519 yes\n");
  expect(run(can([join(state(), "api-token")]), { read: [state()] })).toBe(`${join(state(), "api-token").replace(home, "~")} no\n`);
  // A session whose folder is the home itself: the home is its workspace, the stores and Keel's folders still are not.
  const inHome = run(can(["~/notes/plan.md", "~/.ssh/id_ed25519", join(state(), "api-token")]) + "; touch ~/made-here && echo wrote", { at: home });
  expect(inHome).toBe(`~/notes/plan.md yes\n~/.ssh/id_ed25519 no\n${join(state(), "api-token").replace(home, "~")} no\nwrote\n`);
  rmSync(join(home, "made-here"));
  // A worktree Keel made lives in its state folder: the session works there, and sees nothing else of the state.
  const made = join(state(), "worktrees/x");
  mkdirSync(made, { recursive: true });
  expect(run(`echo work > f && cat f; ${can([join(state(), "api-token")])}`, { at: made })).toBe(`work\n${join(state(), "api-token").replace(home, "~")} no\n`);
  expect(run(`echo work > f && cat f; ${can([join(state(), "api-token")])}`, { at: made, read: [home] })).toBe(`work\n${join(state(), "api-token").replace(home, "~")} no\n`);
});

test.skipIf(!sandboxStatus().available)("the SSH agent's socket is there only when the owner turned it on for the workspace", async () => {
  const sock = join(root, "agent.sock");
  const server = Bun.listen({ unix: sock, socket: { data() {} } });
  put(".ssh/known_hosts", "host key\n");
  try {
    process.env.SSH_AUTH_SOCK = sock;
    const probe = 'if [ -n "$SSH_AUTH_SOCK" ] && [ -S "$SSH_AUTH_SOCK" ]; then echo agent; else echo "no agent"; fi; cat ~/.ssh/known_hosts 2>/dev/null; [ -r ~/.ssh/id_ed25519 ] && echo key-readable; true';
    expect(run(probe)).toBe("no agent\n");
    expect(run(probe, { sshAgent: true })).toBe("agent\nhost key\n");
  } finally {
    delete process.env.SSH_AUTH_SOCK;
    server.stop(true);
  }
});

test("the settings take a folder or a file and refuse the home, the root, Keel's own folders and the machine's runtime folders, by where the entry really is", () => {
  expect(refusedRead("~/projects")).toBeUndefined();
  expect(refusedRead("projects")).toContain("give a full path, or one under ~");
  expect(refusedRead("~")).toContain("would open all of the home folder");
  expect(refusedRead(dirname(home))).toContain("would open all of the home folder");
  expect(refusedRead("/")).toContain("is not a folder or a file");
  expect(refusedRead(join(state(), "spill"))).toContain("Keel's own files");
  // A folder that holds Keel's own folders is taken: they are hidden inside it.
  expect(refusedRead(dirname(configDir()))).toBeUndefined();
  // A link to the home is the home; the machine's runtime folders are not listed.
  symlinkSync(home, join(root, "link-to-home"));
  expect(refusedRead(join(root, "link-to-home"))).toContain("would open all of the home folder");
  for (const p of ["/run", "/run/user/1000", "/proc", "/tmp"]) expect([p, refusedRead(p)]).toEqual([p, expect.stringContaining("a sandbox has its own")]);
  expect(setSandboxConfig({ workspace: { scope: ws, read: ["~/projects", "~"] } })).toContain("would open all of the home folder");
  expect(sandboxConfig()).toEqual({ read: [], env: [], workspaces: {} });
  expect(setSandboxConfig({ read: ["~/notes"], env: ["MY_BUILD_FLAG"], workspace: { scope: ws, read: ["~/projects"], ssh_agent: true } })).toBeUndefined();
  expect(sandboxConfig()).toEqual({ read: ["~/notes"], env: ["MY_BUILD_FLAG"], workspaces: { [ws]: { read: ["~/projects"], ssh_agent: true } } });
  expect(JSON.parse(readFileSync(join(configDir(), "sandbox.json"), "utf8")).workspaces[ws].ssh_agent).toBe(true);
  expect(setSandboxConfig({ env: ["not a name"] })).toContain("is not the name of an environment variable");
  // Turned off and emptied again, the workspace has no entry.
  expect(setSandboxConfig({ read: [], env: [], workspace: { scope: ws, read: [], ssh_agent: false } })).toBeUndefined();
  expect(sandboxConfig()).toEqual({ read: [], env: [], workspaces: {} });
});

test("one rule for commands and file tools: what the view shows, with the stores and Keel's folders judged before the session's folder", () => {
  const at = (p: string, o: { ws?: string; read?: string[]; own?: string[]; scratch?: string[] } = {}) => {
    const v = shownTo(p, o.ws ?? ws, { read: o.read, own: o.own }, o.scratch);
    return v.shown ? "shown" : v.store ? "store" : "hidden";
  };
  // Shown: the workspace, the system, a toolchain, the owner's package caches, what the owner listed, a skill.
  for (const p of [join(ws, ".env"), "/etc/hosts", "/usr/bin/env", join(home, "tools/zzz/lib/data"), join(home, "go/pkg/mod/cache/x"), join(home, ".cache/uv/wheel"), join(configDir(), "skills/x/run.sh"), join(configDir(), "AGENTS.md")]) expect([p, at(p)]).toEqual([p, "shown"]);
  expect(at(join(home, "notes/plan.md"), { read: ["~/notes"] })).toBe("shown");
  expect(at(join(home, ".ssh/id_ed25519"), { read: ["~/.ssh"] })).toBe("shown");
  // Hidden: the rest of the home, another project, the machine's /tmp, /run and /proc, an unlisted cache folder.
  for (const p of [join(home, "notes/plan.md"), join(home, "projects/other/.env"), home, "/tmp/x", "/run/user/1000/bus", "/proc/1/environ", "/var/log/syslog", join(home, ".cache/other-work/notes"), "/mnt/disk/x"]) expect([p, at(p)]).toEqual([p, "hidden"]);
  // Stores: a key (also by a link in the workspace and by a pattern), sign-in files no command list had, shell history.
  symlinkSync(join(home, ".ssh"), join(ws, "keys"));
  for (const p of [join(home, ".ssh/id_ed25519"), join(ws, "keys/id_ed25519"), join(home, ".ssh/*.pub"), join(home, ".config/pypoetry/auth.toml"), join(home, ".config/containers/auth.json"), join(home, ".cache/huggingface/token"), join(home, ".local/share/fish/fish_history"), join(home, ".pgpass"), join(home, ".bash_history")]) expect([p, at(p)]).toEqual([p, "store"]);
  rmSync(join(ws, "keys"));
  // Keel's own: its token, its settings, another session's files. The session's own files, given by Keel, are shown.
  for (const p of [join(state(), "api-token"), join(state(), "keel.db"), join(configDir(), "mcp.json"), join(configDir(), "sandbox.json"), join(state(), "spill/other/out.txt"), join(state(), "artifacts/other/a.md"), join(state(), "attachments/abc/f.csv"), state()]) expect([p, at(p)]).toEqual([p, "store"]);
  expect(at(join(state(), "spill/mine/out.txt"), { scratch: [join(state(), "spill/mine")] })).toBe("shown");
  expect(at(join(state(), "attachments/abc/f.csv"), { own: [join(state(), "attachments")] })).toBe("store"); // (a folder that is not there is not the session's)
  // A session whose folder is the home, or a folder that holds a store: the stores are judged first.
  expect(at(join(home, ".ssh/id_ed25519"), { ws: home })).toBe("store");
  expect(at(join(home, ".config/gh/hosts.yml"), { ws: join(home, ".config") })).toBe("store");
  expect(at(join(state(), "api-token"), { ws: home })).toBe("store");
  expect(at(join(home, "notes/plan.md"), { ws: home })).toBe("shown");
  // A worktree Keel made is the session's folder.
  expect(at(join(state(), "worktrees/x/f"), { ws: join(state(), "worktrees/x") })).toBe("shown");
});

test("a command that looked for what the sandbox hides is told what was hidden and how it is allowed", () => {
  const at = { workspace: ws, shown: () => shownPaths(ws), escape: "ESCAPE." };
  // A path of the home that the view does not show is named whether it exists or not: nothing is told about what the home holds.
  const said = hiddenSaid(`cat: ${home}/notes/plan.md: No such file or directory\nls: cannot access '~/never-was': No such file or directory`, at);
  expect(said).toEqual([`This session's sandbox does not show ${home}/notes/plan.md, ~/never-was: the home folder is not readable there, except the toolchains and what the owner listed. The owner can add a folder to what this session's folder may read, in Settings, Permissions. ESCAPE.`]);
  // A credential store or one of Keel's own files: no way around is offered.
  for (const out of [`cat: ${home}/.ssh/config: No such file or directory`, `cat: ${join(configDir(), "mcp.json")}: No such file or directory`]) {
    const s = hiddenSaid(out, at);
    expect(s).toEqual([expect.stringMatching(/^This session's sandbox does not show .*: the owner's credential stores and Keel's own files are kept from every sandboxed command\.$/)]);
    expect(s.join(" ")).not.toContain("ESCAPE");
  }
  // A relative path (from the folder the command ran in), a path with a space, a write in the home.
  expect(hiddenSaid("cat: ../../notes/plan.md: No such file or directory", { ...at, cwd: join(home, "projects/other") })[0]).toContain("does not show ../../notes/plan.md");
  expect(hiddenSaid(`cat: '${home}/My Documents/tax 2025.pdf': No such file or directory`, at)[0]).toContain(`does not show ${home}/My Documents/tax 2025.pdf`);
  expect(hiddenSaid(`bash: line 1: ${home}/out.txt: Read-only file system`, at)).toEqual([`This session's sandbox writes only in the session's folder: ${home}/out.txt is in the home folder, which is read-only there. Caches go under $XDG_CACHE_HOME and temp files under $TMPDIR. ESCAPE.`]);
  // A path that is shown, and one in the workspace: nothing to say.
  expect(hiddenSaid(`cat: ${home}/tools/zzz/lib/none: No such file or directory\ncat: ${ws}/none: No such file or directory\ncat: ./none: No such file or directory`, at)).toEqual([]);
  // A sign-in or a signature that failed because the credentials are not there, and a browser that could not open.
  for (const out of ["git@github.com: Permission denied (publickey).", "fatal: could not read Username for 'https://github.com': terminal prompts disabled", "To get started with GitHub CLI, please run:  gh auth login", "Cannot connect to the Docker daemon at unix:///var/run/docker.sock.", "Host key verification failed.",
    "error: gpg failed to sign the data", "gpg: Fatal: can't create directory '/home/u/.gnupg': Read-only file system", "xdg-open: no method available for opening 'https://x'", "npm error code E401"]) {
    expect([out, hiddenSaid(out, at)]).toEqual([out, [expect.stringMatching(/^This session's sandbox hides the owner's credentials: SSH keys and the SSH agent, .* The owner can let the commands of this session's folder use the SSH agent, or add a folder to what they may read, in Settings, Permissions\. ESCAPE\.$/)]]);
  }
  expect(hiddenSaid("git@github.com: Permission denied (publickey).", { ...at, sshAgent: true })[0]).not.toContain("use the SSH agent, or");
  // The hidden settings files that exist are named there.
  put(".npmrc", "registry=https://npm.corp.example/\n");
  forgetProfiles();
  expect(hiddenSaid("npm error code E401", at)[0]).toContain("Hidden settings files: ~/.npmrc");
  rmSync(join(home, ".npmrc"));
  expect(hiddenSaid("error: test failed", at)).toEqual([]);
});

test("the view's arguments: the home in memory and the top of the file system hidden first, the stores and Keel's own folders after everything bound, the home closed last", () => {
  forgetProfiles();
  const v = readView(ws, "read-only", { read: [home] });
  const at = (...run: string[]) => v.before.findIndex((_, i) => run.every((a, j) => v.before[i + j] === a));
  expect(at("--tmpfs", "/run")).toBeGreaterThanOrEqual(0);
  expect(at("--tmpfs", "/home")).toBeGreaterThanOrEqual(0);
  expect(at("--tmpfs", "/home")).toBeLessThan(at("--tmpfs", home));
  expect(at("--tmpfs", home)).toBeLessThan(at("--ro-bind", home, home));
  // The stores, then Keel's own two folders; what Keel gives the session from inside them comes after.
  const masks = v.masks.join(" ");
  expect(masks).toContain(`--tmpfs ${join(home, ".ssh")}`);
  expect(masks).toMatch(new RegExp(`--ro-bind \\S+/sandbox/hidden ${join(home, ".netrc")}`));
  expect(masks.indexOf(`--tmpfs ${join(home, ".ssh")}`)).toBeLessThan(masks.indexOf(`--tmpfs ${state()}`));
  expect(masks.indexOf(`--tmpfs ${state()}`)).toBeLessThan(masks.indexOf(`--tmpfs ${configDir()}`));
  expect(v.after.join(" ")).toContain(`--ro-bind ${join(configDir(), "skills")} ${join(configDir(), "skills")}`);
  // The home is closed last in both profiles (the sandbox's own folders in it keep their mode), unless it is the workspace.
  expect([v.last, readView(ws, "workspace-write").last, readView(home, "workspace-write").last]).toEqual([["--remount-ro", home], ["--remount-ro", home], []]);
  expect(v.unset).toContain("SSH_AUTH_SOCK");
});

test.skipIf(!sandboxStatus().available)("a session's profile is kept, and made again off the loop: the command at hand runs with the kept one, the next with what the disk holds now", async () => {
  forgetProfiles();
  const perm = { sandbox: "workspace-write" as const, network: false };
  const first = confine(["true"], perm, ws);
  // The same list of arguments while it is kept (the same object: nothing was built).
  expect(confine(["true"], perm, ws).slice(0, -1)).toEqual(first.slice(0, -1));
  // A toolchain appears. The kept profile does not have it; once it has aged, the next command still runs with the
  // kept one and a new one is made on the sandboxes' thread.
  tool(".deno/bin/deno", "deno-ran");
  expect(confine(["true"], perm, ws).join(" ")).not.toContain(join(home, ".deno/bin"));
  setProfileAge(0);
  try {
    expect(confine(["true"], perm, ws).join(" ")).not.toContain(join(home, ".deno/bin"));
    let now = "";
    for (let i = 0; i < 100 && !now.includes(join(home, ".deno/bin")); i++) { await Bun.sleep(50); setProfileAge(60_000); now = confine(["true"], perm, ws).join(" "); }
    expect(now).toContain(`--ro-bind ${join(home, ".deno/bin")} ${join(home, ".deno/bin")}`);
  } finally {
    setProfileAge(5_000);
    rmSync(join(home, ".deno"), { recursive: true, force: true });
    forgetProfiles();
  }
});

test.skipIf(!sandboxStatus().available)("another checkout is taken only when it and the repository name each other: an entry a command forged shows nothing", () => {
  const git = (dir: string, ...args: string[]) => {
    const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } as Record<string, string> });
    if (r.exitCode) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  };
  const repo = join(home, "repos/app"), linked = join(home, "repos/app-wt"), docs = join(home, "Documents"), other = join(home, "repos/other");
  for (const d of [repo, docs, other]) mkdirSync(d, { recursive: true });
  writeFileSync(join(docs, "tax.txt"), "TAX\n");
  writeFileSync(join(other, ".env"), "OTHER-ENV\n");
  git(repo, "init", "-q");
  writeFileSync(join(repo, "a.txt"), "a\n");
  git(repo, "add", "a.txt");
  git(repo, "commit", "-q", "-m", "one");
  git(repo, "worktree", "add", "-q", linked);
  git(other, "init", "-q");
  try {
    // The real one is another checkout of the repository.
    expect(siblings(repo)).toEqual([linked]);
    expect(siblings(linked)).toEqual([repo]);
    // A command of a main-checkout session writes entries that name the owner's documents, Keel's state, a sibling
    // project and a folder with a .git file of its own making that points nowhere back.
    const forged: [string, string][] = [["docs", join(docs, ".git")], ["state", join(state(), ".git")], ["other", join(other, ".git")], ["spill", join(state(), "spill/.git")]];
    writeFileSync(join(state(), "spill/.git"), "gitdir: /nowhere\n");
    const made = run(forged.map(([name, to]) => `mkdir -p .git/worktrees/${name} && echo ${to} > .git/worktrees/${name}/gitdir && echo ../.. > .git/worktrees/${name}/commondir && cp .git/HEAD .git/worktrees/${name}/HEAD`).join("; ") + "; echo made", { at: repo });
    expect(made).toBe("made\n");
    expect(siblings(repo)).toEqual([linked]);
    // The next command sees none of them, and neither does a file tool.
    expect(run(`cat ${join(docs, "tax.txt")} ${join(other, ".env")} ${join(state(), "api-token")} 2>&1 | grep -c 'No such file'; cat ${join(linked, "a.txt")}`, { at: repo })).toBe("3\na\n");
    for (const p of [join(docs, "tax.txt"), join(other, ".env")]) expect([p, shownTo(p, repo).shown]).toEqual([p, false]);
    expect(shownTo(join(linked, "a.txt"), repo).shown).toBe(true);
    // A folder whose .git file points back at an entry is one the command could already write: it is inside the session's folder.
    const mine = run(`mkdir -p made-wt .git/worktrees/mine && echo "gitdir: $PWD/.git/worktrees/mine" > made-wt/.git && echo "$PWD/made-wt/.git" > .git/worktrees/mine/gitdir; echo ok`, { at: repo });
    expect(mine).toBe("ok\n");
    expect(siblings(repo)).toEqual([linked]);
    // A worktree Keel made, in its state, is one of the repository's checkouts only to the session whose agent's it
    // is: another session's worktree of the same repository is that session's.
    const kept = join(state(), "worktrees");
    mkdirSync(kept, { recursive: true });
    git(repo, "worktree", "add", "-q", join(kept, "agent-1"));
    git(repo, "worktree", "add", "-q", join(kept, "other-session"));
    writeFileSync(join(kept, "other-session/notes.txt"), "OTHER-SESSION\n");
    expect(siblings(repo)).toEqual([linked]);
    expect(siblings(repo, [join(kept, "agent-1")]).sort()).toEqual([linked, join(kept, "agent-1")].sort());
    expect(run(`cat ${join(kept, "other-session/notes.txt")} 2>&1 | grep -c 'No such file'; ls ${join(kept, "agent-1")} | head -1`, { at: repo, worktrees: [join(kept, "agent-1")] })).toBe("1\na.txt\n");
    expect(shownTo(join(kept, "other-session/notes.txt"), repo, { worktrees: [join(kept, "agent-1")] }).shown).toBe(false);
    git(repo, "worktree", "remove", "--force", join(kept, "agent-1"));
    git(repo, "worktree", "remove", "--force", join(kept, "other-session"));
    // A session whose folder says it is a worktree of a repository that does not name it has no other checkouts.
    const stray = join(home, "repos/stray");
    mkdirSync(stray, { recursive: true });
    writeFileSync(join(stray, ".git"), `gitdir: ${join(repo, ".git/worktrees/app-wt")}\n`);
    expect(siblings(stray)).toEqual([]);
  } finally {
    rmSync(join(home, "repos"), { recursive: true, force: true });
    rmSync(docs, { recursive: true, force: true });
    rmSync(join(state(), "spill/.git"), { force: true });
  }
});
