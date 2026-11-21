// Loaded by `bun test` before any test file (bunfig.toml): a test never reads
// or writes the owner's own config or state. Code under test looks in the
// config folder (MCP servers, hooks, skills, plugins, agents) and the state
// folder unless told otherwise, and a scratch state folder alone is not
// enough: the config folder is separate. Here both, and what else a test can
// reach on the machine, point into one fresh folder that is removed at exit.
// A test that needs its own sets it over these.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
});
// A path the shell names for one config file would point past the scratch folder.
for (const k of ["KEEL_MCP_CONFIG", "KEEL_HOOKS", "KEEL_ACP_AGENTS", "KEEL_ACP_FOLDERS"]) delete process.env[k];
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
