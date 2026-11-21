// Loaded by `bun test` before any test file (bunfig.toml): a test never reads
// or writes the owner's own config or state. Code under test looks in the
// config folder (MCP servers, hooks, skills, plugins, agents) and the state
// folder unless told otherwise, and a scratch state folder alone is not
// enough: the config folder is separate. Here both, and what else a test can
// reach on the machine, point into one fresh folder, removed when the last
// test is done. A test that needs its own sets it over these.
import { afterAll, afterEach, beforeEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { allHooks } from "../src/engine/hooks.ts";

const dir = mkdtempSync(join(tmpdir(), "keel-test-"));
const made = (...p: string[]) => {
  const d = join(dir, ...p);
  mkdirSync(d, { recursive: true });
  return d;
};
Object.assign(process.env, {
  KEEL_CONFIG_DIR: made("config"),
  KEEL_STATE_DIR: made("state"),
  // The other agents' setup and session stores (MCP import, keel port, session import).
  KEEL_IMPORT_HOME: made("import", "home"),
  KEEL_IMPORT_CLAUDE_DIR: join(dir, "import", "claude"),
  KEEL_IMPORT_CODEX_DIR: join(dir, "import", "codex"),
  KEEL_IMPORT_AGY_DIR: join(dir, "import", "agy"),
  KEEL_IMPORT_KEEL_DB: join(dir, "import", "keel.db"),
  KEEL_IMPORT_HERMES_DIR: join(dir, "import", "hermes"),
  KEEL_MCP_REGISTRY: `file://${join(dir, "registry.json")}`,
  KEEL_MAIL_STANDIN: join(dir, "mail"),
  KEEL_PHONE_SOCKET: join(made("phone"), "phone.sock"),
  KEEL_DESKTOP_NOTIFY: "off",
  // No test looks a key up in the owner's keyring or runs their credential
  // helper: both answer "no key" at once (the helper took seconds at times,
  // and a test that named a made-up key timed out waiting for it).
  KEEL_KEYRING_SERVICE: "keel-test-empty",
  KEEL_CRED_GET: "/bin/false",
});
// A path the shell names for one config file would point past the scratch folder.
for (const k of ["KEEL_MCP_CONFIG", "KEEL_HOOKS", "KEEL_ACP_AGENTS", "KEEL_ACP_FOLDERS"]) delete process.env[k];

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
const kept = new Set<object>(allHooks());
const seen = new Set<string>();
let file = "";
let afterLast: object[] = []; // registered when the file's last test so far ended
function leftBehind() {
  const left = afterLast.filter((h) => !kept.has(h) && allHooks().includes(h as any));
  afterLast = [];
  if (!left.length) return;
  // Taken off, so the files after it are not failed by them as well.
  for (const h of left) allHooks().splice(allHooks().indexOf(h as any), 1);
  throw new Error(`${file} ended with ${left.length} turn hook${left.length > 1 ? "s" : ""} of its own still registered (${left.map((h) => Object.keys(h).join("+")).join("; ")}). Hooks are process-wide: take them off in the test that adds them, or in afterAll.`);
}
beforeEach(() => {
  const now = Object.keys(require.cache).find((k) => /\.test\.tsx?$/.test(k) && !seen.has(k));
  if (!now) return;
  seen.add(now);
  try {
    leftBehind();
  } finally {
    file = relative(join(import.meta.dir, ".."), now);
  }
});
afterEach(() => { afterLast = [...allHooks()]; });
// Once, after the last test file (bun test fires no exit event from a preload).
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  leftBehind();
});
