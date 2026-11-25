// The stand-ins of a scratch daemon: for each thing a daemon would otherwise
// reach on the machine (gh and the GitHub API, the other harnesses' sessions
// and setups, the MCP registry, the memory store, voice, the phone, mail, ssh),
// the stand-in or the scratch folder it gets instead. The one list:
// scripts/dev.sh exports it (and so scripts/smoke.sh), and a daemon a spec
// starts gets it with an environment made from nothing (test/e2e/own-daemon.ts).
//
//   bun scripts/scratch-env.ts DIR    prints `export NAME='value'` lines for a shell,
//                                     keeping what the environment already names,
//                                     and makes the folders and files they name
import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "..");
const fixture = (name: string) => join(REPO, "test/e2e/fixtures", name);

// `host`: the ssh configuration names the stand-in host (the ssh machine e2e
// enables it); a daemon made from nothing has an empty one. Neither includes
// the caller's own ~/.ssh/config: a scratch daemon lists none of his machines.
// MOMENTUM_BIN names no file, so no supervisor report of his is read either.
export function standIns(dir: string, { host = false } = {}): Record<string, string> {
  return {
    KEEL_CONFIG_DIR: join(dir, "config"),
    KEEL_DESKTOP_NOTIFY: "off",
    KEEL_SCRIPTED_PROVIDER: "1",
    KEEL_GH_BIN: fixture("gh-standin.sh"),
    // The pull request watcher's API: nothing answers there unless a spec names its stand-in.
    KEEL_GITHUB_API: "http://127.0.0.1:9",
    KEEL_IMPORT_CLAUDE_DIR: join(dir, "import/claude"),
    KEEL_IMPORT_CODEX_DIR: join(dir, "import/codex"),
    // A Codex session answered in place talks to this stand-in of `codex app-server`, never the owner's codex.
    KEEL_CODEX_BIN: fixture("codex-app-server.ts"),
    // A Claude Code session answered in place talks to this stand-in of `claude -p`, never the owner's claude.
    KEEL_CLAUDE_BIN: fixture("claude-code.ts"),
    KEEL_IMPORT_AGY_DIR: join(dir, "import/agy"),
    KEEL_IMPORT_KEEL_DB: join(dir, "import/keel.db"),
    KEEL_IMPORT_HERMES_DIR: join(dir, "import/hermes"),
    KEEL_IMPORT_OPENCODE_DIR: join(dir, "import/opencode"),
    KEEL_IMPORT_GEMINI_DIR: join(dir, "import/gemini"),
    KEEL_IMPORT_GROK_DIR: join(dir, "import/grok"),
    KEEL_IMPORT_KIMI_DIR: join(dir, "import/kimi"),
    KEEL_IMPORT_PI_DIR: join(dir, "import/pi"),
    KEEL_IMPORT_CURSOR_DIR: join(dir, "import/cursor"),
    KEEL_IMPORT_COPILOT_DIR: join(dir, "import/copilot"),
    KEEL_IMPORT_AIDER_DIR: join(dir, "import/aider"),
    KEEL_IMPORT_QWEN_DIR: join(dir, "import/qwen"),
    KEEL_IMPORT_GOOSE_DIR: join(dir, "import/goose"),
    KEEL_IMPORT_CRUSH_DIR: join(dir, "import/crush"),
    // The other agents' setups (MCP configs, and what `keel port` brings) are read from a scratch home.
    KEEL_IMPORT_HOME: join(dir, "import/home"),
    // A saved listing beside the state (the connect e2e writes it), not the public registry.
    KEEL_MCP_REGISTRY: `file://${join(dir, "registry.json")}`,
    TACIT_BIN: fixture("tacit-standin.sh"),
    MOMENTUM_BIN: join(dir, "no-momentum"),
    KEEL_WEB_ENV: join(dir, "no-web-env"),
    TACIT_STANDIN_STORE: join(dir, "tacit-store"),
    KEEL_MAIL_STANDIN: join(dir, "mail"),
    KEEL_PARLAR: join(dir, "parlar/parlar"),
    KEEL_PHONE_SOCKET: join(dir, "phone/phone.sock"),
    // One ssh host is a stand-in: this machine with a scratch home, reached by the stand-in ssh.
    KEEL_SSH_STANDIN_HOST: "keel-standin",
    KEEL_SSH_STANDIN_HOME: join(dir, "box"),
    KEEL_SSH: fixture("ssh-standin.sh"),
    KEEL_SSH_CONFIG: join(dir, host ? "ssh/config" : "ssh/config-empty"),
  };
}

// The folders and files the list names, for the values it gave (a value the
// caller named instead is the caller's to make).
export function prepare(env: Record<string, string | undefined>, dir: string, { host = false } = {}): void {
  const own = standIns(dir, { host });
  const mine = (k: string) => env[k] === own[k];
  for (const k of ["KEEL_CONFIG_DIR", "KEEL_IMPORT_HOME", "KEEL_SSH_STANDIN_HOME"]) if (env[k]) mkdirSync(env[k]!, { recursive: true });
  if (env.KEEL_PHONE_SOCKET) mkdirSync(dirname(env.KEEL_PHONE_SOCKET), { recursive: true });
  if (mine("KEEL_PARLAR")) {
    mkdirSync(dirname(own.KEEL_PARLAR!), { recursive: true });
    copyFileSync(fixture("parlar-standin.py"), own.KEEL_PARLAR!);
    chmodSync(own.KEEL_PARLAR!, 0o755);
  }
  if (mine("KEEL_SSH_CONFIG")) {
    mkdirSync(dirname(own.KEEL_SSH_CONFIG!), { recursive: true });
    writeFileSync(own.KEEL_SSH_CONFIG!, host ? `Host ${env.KEEL_SSH_STANDIN_HOST}\n` : "");
  }
}

const quote = (v: string) => `'${v.replaceAll("'", `'\\''`)}'`;

if (import.meta.main) {
  const dir = process.argv[2];
  if (!dir) { console.error("usage: bun scripts/scratch-env.ts DIR"); process.exit(2); }
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(standIns(dir, { host: true }))) env[k] = process.env[k]?.trim() || v;
  prepare(env, dir, { host: true });
  for (const [k, v] of Object.entries(env)) console.log(`export ${k}=${quote(v)}`);
}
