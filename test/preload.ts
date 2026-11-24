// Loaded by `bun test` before any test file (bunfig.toml): a test never reads
// or writes the owner's own config or state. Code under test looks in the
// config folder (MCP servers, hooks, skills, plugins, agents) and the state
// folder unless told otherwise, and a scratch state folder alone is not
// enough: the config folder is separate. Here both, and what else a test can
// reach on the machine, point into one fresh folder, removed when the last
// test is done. A test that needs its own sets it over these.
import { afterAll, afterEach, beforeEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { allHooks } from "../src/engine/hooks.ts";
import { vault } from "../src/safety/secrets.ts";

const dir = mkdtempSync(join(tmpdir(), "keel-test-"));
const made = (...p: string[]) => {
  const d = join(dir, ...p);
  mkdirSync(d, { recursive: true });
  return d;
};
// The memory store's command line: a stand-in that answers nothing, so no
// test reaches the owner's store whatever is on the PATH or in the shell. A
// test of the memory hooks passes a stand-in of its own.
const noStore = join(made("bin"), "no-store.sh");
writeFileSync(noStore, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
const home = made("home");
const scratch: Record<string, string> = {
  // The home folder (src/core/paths.ts homeDir): what reads ~/.claude, ~/.codex, ~/.config
  // and the like finds nothing of the owner's.
  HOME: home,
  TACIT_BIN: noStore,
  // The supervisor's report: the same stand-in, so no test reads the owner's.
  MOMENTUM_BIN: noStore,
  KEEL_WEB_ENV: join(dir, "no-web-env"),
  KEEL_CONFIG_DIR: made("config"),
  KEEL_STATE_DIR: made("state"),
  // The other agents' setup and session stores (MCP import, keel port, session import).
  KEEL_IMPORT_HOME: made("import", "home"),
  KEEL_IMPORT_CLAUDE_DIR: join(dir, "import", "claude"),
  KEEL_IMPORT_CODEX_DIR: join(dir, "import", "codex"),
  KEEL_IMPORT_AGY_DIR: join(dir, "import", "agy"),
  KEEL_IMPORT_KEEL_DB: join(dir, "import", "keel.db"),
  KEEL_IMPORT_HERMES_DIR: join(dir, "import", "hermes"),
  KEEL_IMPORT_OPENCODE_DIR: join(dir, "import", "opencode"),
  KEEL_IMPORT_GEMINI_DIR: join(dir, "import", "gemini"),
  KEEL_MCP_REGISTRY: `file://${join(dir, "registry.json")}`,
  KEEL_MAIL_STANDIN: join(dir, "mail"),
  KEEL_PHONE_SOCKET: join(made("phone"), "phone.sock"),
  KEEL_DESKTOP_NOTIFY: "off",
  // No test looks a key up in the owner's keyring or runs their credential
  // helper: both answer "no key" at once (the helper took seconds at times,
  // and a test that named a made-up key timed out waiting for it).
  KEEL_KEYRING_SERVICE: "keel-test-empty",
  KEEL_CRED_GET: "/bin/false",
};
Object.assign(process.env, scratch);
// A path the shell names for one config file would point past the scratch folder.
const unset = ["KEEL_MCP_CONFIG", "KEEL_HOOKS", "KEEL_ACP_AGENTS", "KEEL_ACP_FOLDERS"];
for (const k of unset) delete process.env[k];
// What every file starts with: the settings above, as they are here.
const start: Record<string, string | undefined> = { ...scratch, ...Object.fromEntries(unset.map((k) => [k, undefined])) };

// Turn hooks are process-wide (src/engine/hooks.ts): one a test file leaves
// registered runs in every later file's turns, on a store that file closed. A
// file must end with no hook of its own registered. The one hook a module
// registers as it loads (the skills listing) is registered here, before any
// file, and is the only one that stays; a new module of that kind is
// imported here too. bun test names no current file to a preload, so a file
// starts when its module first shows in the module cache, and what the file
// before it left is what was registered after its last test and still is
// (its afterAll ran in between; what the new file registered while loading
// was not there then).
await import("../src/tools/skills.ts");
const settingsModule = await import("../src/admin/settings.ts");
// What the automation modules run on a timer against the parts a file set (the
// looks at agents parked on a command) stops when the next file starts, whether
// or not that file sets parts of its own (src/automation/core.ts partsGone).
const { partsGone } = await import("../src/automation/core.ts");
const kept = new Set<object>(allHooks());
const seen = new Set<string>();
let file = "";
let afterLast: object[] = []; // registered when the file's last test so far ended
// The secrets vault is process-wide the same way (src/safety/secrets.ts): the
// secrets routes tie it to a store, and a file that leaves it tied to a store
// it closed fails every later file's shell command, which asks the vault who
// holds a secret. Which files come later is the folder's order on the disk,
// so it differs from one machine to the next.
let tiedAfterLast: object | null = null; // the vault's tie when the file's last test so far ended
// And the settings above are the process's environment: a file that points one
// at a folder of its own and leaves it there gives that folder, removed by
// then, to every later file.
let envAfterLast: Record<string, string | undefined> | null = null; // the settings when the file's last test so far ended
// The settings (src/admin/settings.ts) are the process's too: the file they save to is the last
// one loaded. A file that loads a folder of its own and removes it leaves a file no later save
// can write (ENOENT in every later file that changes a setting).
let settingsAfterLast = ""; // the settings file when the file's last test so far ended
// The file a changed value was first seen at the end of: a file after it that
// sets its own and then puts back what it found hands the value on, and is not
// the one that left it.
const cameFrom = new Map<string, string>();
function leftBehind() {
  const left = afterLast.filter((h) => !kept.has(h) && allHooks().includes(h as any));
  afterLast = [];
  const tied = tiedAfterLast !== null && vault.ledger === tiedAfterLast;
  tiedAfterLast = null;
  // Still what the file's last test left, and not what a file starts with (a
  // new file that set one while loading has its own value by now).
  const moved = envAfterLast ? Object.keys(start).filter((k) => process.env[k] !== start[k] && process.env[k] === envAfterLast![k]) : [];
  envAfterLast = null;
  const { loadSettings, settingsFile } = settingsModule;
  const gone = settingsAfterLast !== "" && settingsFile() === settingsAfterLast && !existsSync(dirname(settingsAfterLast)) ? settingsAfterLast : "";
  settingsAfterLast = "";
  if (gone) loadSettings(process.env.KEEL_STATE_DIR!, () => {});
  if (!left.length && !tied && !moved.length && !gone) return;
  const by = new Map<string, string[]>();
  for (const k of moved) {
    const value = `${k}=${process.env[k] ?? "(unset)"}`, from = cameFrom.get(value) ?? file;
    by.set(from, [...(by.get(from) ?? []), value]);
  }
  for (const k of moved) { if (start[k] === undefined) delete process.env[k]; else process.env[k] = start[k]; }
  // Taken off, so the files after it are not failed by them as well.
  for (const h of left) allHooks().splice(allHooks().indexOf(h as any), 1);
  if (tied) { vault.ledger = null; vault.parentOf = () => null; }
  const said: string[] = [];
  if (left.length) said.push(`${file} ended with ${left.length} turn hook${left.length > 1 ? "s" : ""} of its own still registered (${left.map((h) => Object.keys(h).join("+")).join("; ")}). Hooks are process-wide: take them off in the test that adds them, or in afterAll.`);
  if (gone) said.push(`${file} ended with the settings tied to ${gone}, a folder it removed. The settings are process-wide: load the scratch state folder again (loadSettings(process.env.KEEL_STATE_DIR!, () => {})) in afterAll.`);
  if (tied) said.push(`${file} ended with the secrets vault still tied to its store. The vault is process-wide: set vault.ledger to null and vault.parentOf to () => null before the store closes.`);
  for (const [from, values] of by) said.push(`${from} ended with settings of the environment changed: ${values.join(", ")}. The environment is process-wide: put back what a test changed, in the test or in afterAll (test/env.ts does both).`);
  throw new Error(said.join("\n"));
}
beforeEach(() => {
  // Every test module not seen yet, in the order they loaded: the last is the
  // file this test is in, and the ones before it ran no test (all skipped).
  // All are seen from here, so none of them reads as a new file later, in
  // the middle of this one.
  const fresh = Object.keys(require.cache).filter((k) => /\.test\.tsx?$/.test(k) && !seen.has(k));
  if (!fresh.length) return;
  for (const k of fresh) seen.add(k);
  partsGone();
  try {
    leftBehind();
  } finally {
    file = relative(join(import.meta.dir, ".."), fresh.at(-1)!);
  }
});
afterEach(() => {
  afterLast = [...allHooks()];
  tiedAfterLast = vault.ledger;
  settingsAfterLast = settingsModule.settingsFile();
  envAfterLast = Object.fromEntries(Object.keys(start).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(envAfterLast)) if (v !== start[k] && !cameFrom.has(`${k}=${v ?? "(unset)"}`)) cameFrom.set(`${k}=${v ?? "(unset)"}`, file);
});
// Once, after the last test file (bun test fires no exit event from a preload).
afterAll(() => {
  // (A sandbox's cache layers hold folders the kernel made with no permissions: opened up first.)
  Bun.spawnSync(["chmod", "-R", "u+rwX", join(dir, "state")], { stdout: "ignore", stderr: "ignore" });
  try {
    leftBehind();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
