// Where credentials are kept, one list for every way a session reads: its file
// tools (Read, Grep, Glob and their kin in each family's tool set), the reading
// commands of its shell (cat, head, grep -r over the home), and what its sandbox
// hides (sandbox-view.ts hides HIDDEN, which is STORES and what a command does
// not need either). Paths in, the store out: credentialAt looks at the disk only
// through what its caller gives it (`dir`); the functions that look say so.
//
// A credential path is one of:
// - a store of the home: login keys, cloud and registry tokens, keyrings,
//   password managers, browser profiles, other harnesses' sign-ins (STORES);
// - a file whose name says it holds one wherever it is: environment files
//   (`.env`, `.env.local`, not `.env.example`), private keys, keystores, token
//   and credential files (credentialName);
// - one of Keel's own secrets: its API token, the key its placeholders are made
//   with, its sessions' store, its MCP sign-ins, its provider keys (KEEL_STATE,
//   KEEL_CONFIG);
// - a system file of the same kind (/etc/shadow, a host's private ssh key).
import { lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { timed } from "../admin/stall.ts";
import { contains as inside, realOf } from "../core/paths.ts";
import { credentialName as secretName, entropy } from "./secrets.ts";

// The owner's home as their programs know it: HOME, which a command inherits (as the sandbox reads it).
export const homeOf = () => (process.env.HOME && isAbsolute(process.env.HOME) ? process.env.HOME : homedir());


// The credential stores of a home, relative to it: a folder whose files are all
// the owner's sign-ins, or one such file. What each holds, by the program that
// keeps it there.
export const STORES = [
  // Login keys and keyrings.
  ".ssh", ".gnupg", ".password-store", ".local/share/keyrings", ".local/share/kwalletd", "Library/Keychains",
  ".config/op", ".config/1Password", ".config/Bitwarden", ".config/Bitwarden CLI", ".config/sops",
  // Cloud, cluster and registry logins.
  ".aws", ".azure", ".config/gcloud", ".oci", ".kube", ".minikube", ".docker", ".config/containers/auth.json",
  ".config/doctl", ".config/hcloud", ".config/nebius", ".config/helm", ".fly", ".wrangler", ".cloudflared", ".vault-token", ".terraform.d",
  ".boto", ".s3cfg", ".config/rclone", ".netrc", "_netrc", ".git-credentials", ".config/git/credentials", ".config/gh", ".config/hub", ".config/glab-cli",
  // Package registries.
  ".npmrc", ".yarnrc.yml", ".pypirc", ".config/pip/pip.conf", ".pip/pip.conf", ".config/pypoetry/auth.toml", ".config/configstore", ".bunfig.toml",
  ".cargo/credentials.toml", ".cargo/credentials", ".gem/credentials", ".pub-cache/credentials.json",
  ".m2/settings.xml", ".m2/settings-security.xml", ".gradle/gradle.properties", ".composer/auth.json", ".config/composer/auth.json", ".hex/hex.config",
  // Databases and display.
  ".pgpass", ".my.cnf", ".Xauthority",
  // Model and tool sign-ins: each harness's own login file (its sessions and settings are not credentials).
  ".cache/huggingface/token", ".cache/huggingface/stored_tokens", ".config/github-copilot",
  ".claude.json", ".claude/.credentials.json", ".codex/auth.json", ".gemini/oauth_creds.json", ".gemini/google_accounts.json", ".local/share/opencode/auth.json", ".local/share/opencode/mcp-auth.json",
  ".config/opencode/auth.json", ".qwen/oauth_creds.json", ".kimi/credentials", ".kimi-code/credentials", ".grok/auth.json", ".grok/user-settings.json", ".hermes/auth.json", ".hermes/.env",
  ".cursor/cli-config.json", ".config/cursor/auth.json", ".aider.conf.yml", ".aider/oauth-keys.env", ".local/share/amp/secrets.json",
  // What the owner typed and ran: commands carry tokens (`export TOKEN=...`, `curl -H "Authorization: ..."`, a password given to a client).
  ".bash_history", ".zsh_history", ".python_history", ".node_repl_history", ".psql_history", ".mysql_history", ".sqlite_history", ".rediscli_history", ".irb_history", ".lesshst", ".viminfo",
  ".local/share/fish/fish_history", ".local/share/zsh/history", ".local/share/atuin", ".histfile",
  // Browser and mail profiles: cookies, saved passwords, session tokens.
  ".mozilla", ".thunderbird", ".config/google-chrome", ".config/google-chrome-beta", ".config/chromium", ".config/BraveSoftware", ".config/microsoft-edge", ".config/vivaldi",
  "snap/firefox", "snap/chromium", ".var/app/org.mozilla.firefox", ".var/app/com.google.Chrome",
  "Library/Application Support/Google/Chrome", "Library/Application Support/Firefox", "Library/Cookies",
] as const;

// What a sandbox hides that a file tool may read: a harness's whole folder (its sessions and settings are not
// credentials, but its sign-in and its history sit beside them), what runs at login, the settings that decide where
// packages come from, and editor state.
const HIDDEN_ONLY = [
  ".claude", ".codex", ".gemini", ".cursor", ".grok", ".kimi", ".kimi-code", ".opencode", ".config/opencode", ".local/share/opencode", ".hermes", ".aider",
  ".bashrc", ".bash_profile", ".bash_login", ".profile", ".zshrc", ".zshenv", ".zprofile", ".zlogin", ".config/fish",
  ".config/environment.d", ".config/systemd/user", ".config/containers", ".config/pypoetry", ".config/pnpm", ".config/pip", ".pip", ".local/share/fish", ".config/uv", ".gemrc",
  ".config/Code", ".config/Cursor", ".config/zed", ".vscode", ".vscode-server", ".local/share/zed", ".config/JetBrains", ".local/share/JetBrains",
];
// Everything a sandbox hides, each place once: one inside another is left to the one that holds it.
const ALL: string[] = [...STORES, ...HIDDEN_ONLY];
export const HIDDEN: string[] = ALL.filter((s, i) => ALL.indexOf(s) === i && !ALL.some((o) => o !== s && s.startsWith(o + "/")));

// In ~/.ssh, what holds no secret: public keys, the hosts it knows, its client settings.
const SSH_PUBLIC = /^(?:.+\.pub|known_hosts(?:\.old)?|config|authorized_keys2?)$/;

// Keel's own secrets in its state folder and in its config folder, by name.
// The rest of either folder (a session's outputs and artifacts, a worktree Keel
// made, its skills and instruction files) is not a credential.
export const KEEL_STATE = /^(?:api-token|secret-key|mcp-bind\.key|mcp-oauth\.json|ssh(?:\/.*)?|keel\.db(?:-wal|-shm|-journal)?|log-pages\.db(?:-wal|-shm)?)$/;
export const KEEL_CONFIG = /^(?:providers\.toml|mcp\.json|drive\.json|[\w.-]*auth[\w.-]*\.json|endpoints(?:\/.*)?)(?:\.prev)?$/;
// Two of the config's files an agent may still learn about, through Keel's API, which gives the servers and the
// endpoints without their values: what the refusal of a read of them says to do.
const API_VIEWS: [RegExp, string][] = [
  [/^mcp\.json(?:\.prev)?$/, "`keel mcp list` (GET /api/mcp/servers) lists the MCP servers with their keys, tokens and headers left out"],
  [/^(?:providers\.toml|endpoints(?:\/.*)?)(?:\.prev)?$/, "`keel providers` (GET /api/providers) lists the providers and endpoints with their keys left out"],
];

// System files that hold credentials.
const SYSTEM = /^\/etc\/(?:shadow|gshadow|shadow-|gshadow-|ssh\/ssh_host_[\w-]+_key)$/i;

// A name that is what it stands for, not a credential: an example, a template.
const EXAMPLE = /\.(?:example|sample|template|tmpl|dist|defaults?|schema|md|txt\.example)$/i;

// A file whose name says it holds a credential, wherever it is.
export function credentialName(name: string): boolean {
  const b = name.toLowerCase();
  if (!b || EXAMPLE.test(b) || b.endsWith(".pub")) return false;
  // Environment files: `.env`, `.env.local`, `prod.env`, direnv's `.envrc`.
  if (b === ".env" || b === ".envrc" || b.startsWith(".env.") || b.startsWith(".envrc.") || (b.endsWith(".env") && b.length > 4)) return true;
  // What the owner ran: a shell's or a client's history.
  if (/^\.?(?:bash|zsh|fish|sh|ksh|csh|tcsh|dash|python|node_repl|psql|mysql|mariadb|sqlite|rediscli|irb|pry|duckdb|mongo|lua|gdb)_?history$/.test(b) || b === ".lesshst" || b === ".viminfo") return true;
  // Private keys and keystores.
  if (/^id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?(?:[-_.][\w-]*)?$/.test(b)) return true;
  if (/\.(?:key|p12|pfx|jks|keystore|kdbx|ppk)$/.test(b)) return true;
  if (/^(?:priv(?:ate)?[-_]?key|key|privkey|[\w.-]+[-_.](?:priv(?:ate)?[-_]?key|key))\.pem$/.test(b)) return true;
  // Token and credential files.
  if (/^\.?(?:netrc|pgpass|git-credentials|htpasswd|vault-token)$/.test(b)) return true;
  if (/^(?:\.?credentials|secrets?)(?:\.(?:json|ya?ml|toml|ini|env|txt|conf|cfg|xml))?$/.test(b) || b === "token" || b === "token.json") return true;
  if (/^client_secrets?[\w.-]*\.json$/.test(b) || /^service[-_]?account[\w.-]*\.json$/.test(b) || /^application_default_credentials\.json$/.test(b) || /^oauth[-_]?creds\.json$/.test(b)) return true;
  if (/[-_.](?:secrets?|credentials?)\.(?:json|ya?ml|toml|ini|env|conf|cfg)$/.test(b)) return true;
  if (/^kubeconfig(?:[-_.][\w.-]*)?$/.test(b) || /\.tfstate(?:\.backup)?$/.test(b)) return true;
  return false;
}

// `api`: what an agent may do instead of reading it (Keel's API shows it with the values left out).
// `foreign`: the file is another name for one of the owner's credentials (a hard link, or a link that lands in the
// places listed), wherever that name stands: it is never "the session's own file", even inside its folder.
export type Credential = { path: string; store: string; what: string; api?: string; foreign?: true };
// `own`: Keel's state and config folders, where the daemon runs from. `fold`: the disk does not tell `.SSH` from
// `.ssh` (macOS, Windows, a casefolded folder: foldsCase), so every listed name is matched in any case. `dir`:
// whether a path is a folder: one that is named like a key file (a folder `secrets`, `.env`, `token`) is not a key.
// `names`: false leaves out the rule of names (a path is judged by where it is alone).
export type CredentialPlaces = { home: string; state?: string; config?: string; fold?: boolean; dir?: (path: string) => boolean; names?: boolean };

const tilde = (p: string, home: string) => (p === home ? "~" : inside(home, p) ? `~/${p.slice(home.length + 1)}` : p);
const lower = (s: string) => s.toLowerCase();
// Whether a path is a folder, as the disk says; a path that is not there is not.
export const isFolder = (p: string) => { try { return statSync(p).isDirectory(); } catch { return false; } };

// The credential a path is, or is in. The path is absolute; links are the caller's to resolve (it asks for the
// path as named and for where it lands).
export function credentialAt(path: string, at: CredentialPlaces): Credential | null {
  if (!isAbsolute(path)) return null;
  const p = resolve(path);
  const home = at.home;
  const fold = !!at.fold;
  // (On a disk that folds case, the places are compared in lower case and the answer names the path as it was given.)
  const is = (root: string, x: string) => (fold ? inside(lower(root), lower(x)) : inside(root, x));
  const part = (root: string, x: string) => x.slice(root.length + 1);
  if (SYSTEM.test(fold ? lower(p) : p)) return { path: p, store: p, what: `${p}, a system file that holds credentials` };
  if (at.state && is(at.state, p) && lower(p) !== lower(at.state) && (fold ? new RegExp(KEEL_STATE.source, "i") : KEEL_STATE).test(part(at.state, p)))
    return { path: p, store: p, what: `${tilde(p, home)}, one of Keel's own secrets (its token, its keys, its sessions' store or its sign-ins)` };
  if (at.config && is(at.config, p) && lower(p) !== lower(at.config)) {
    const rel = part(at.config, p);
    if ((fold ? new RegExp(KEEL_CONFIG.source, "i") : KEEL_CONFIG).test(rel)) {
      const api = API_VIEWS.find(([re]) => re.test(fold ? lower(rel) : rel))?.[1];
      return { path: p, store: p, what: `${tilde(p, home)}, Keel's own provider keys or sign-ins`, ...(api ? { api } : {}) };
    }
  }
  if (home && is(home, p) && lower(p) !== lower(home)) {
    const rel = part(home, p);
    for (const s of STORES) {
      const [r, x] = fold ? [lower(rel), lower(s)] : [rel, s];
      if (r !== x && !r.startsWith(x + "/")) continue;
      if (s === ".ssh" && r !== x && SSH_PUBLIC.test(r.slice(x.length + 1))) break;
      const store = join(home, s);
      return { path: p, store, what: `${tilde(p, home)}, ${r === x ? "" : `in ${tilde(store, home)}, `}where the owner's credentials are kept` };
    }
  }
  const name = basename(p);
  if (at.names !== false && credentialName(name) && !at.dir?.(p)) return { path: p, store: p, what: `${tilde(p, home)}, a file that holds credentials by its name` };
  return null;
}

// ---- what looks at the disk ----

const folding = new Map<string, boolean>();
// Whether the disk under a folder does not tell two spellings of a name apart: the folder's own name with its
// letters' case turned reaches the same folder. Asked once for each folder.
export function foldsCase(dir: string): boolean {
  let known = folding.get(dir);
  if (known !== undefined) return known;
  known = false;
  const turned = basename(dir).replace(/[A-Za-z]/g, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()));
  if (turned !== basename(dir)) {
    try {
      const a = statSync(dir), b = statSync(join(dirname(dir), turned));
      known = a.ino === b.ino && a.dev === b.dev;
    } catch {}
  }
  folding.set(dir, known);
  return known;
}

// The places a path is judged against: the home and Keel's own folders as given, with the disk's own answers (whether it folds
// case, whether a path is a folder).
export const placesOf = (home: string, own: { state?: string; config?: string } = {}): CredentialPlaces => ({ home, ...own, fold: foldsCase(home), dir: isFolder });

// The files that hold credentials, by where the disk keeps them (device and inode): each file of the home's
// stores (to a depth and a number of files, browser profiles being large) and Keel's own secrets at the top of its
// folders. Kept for a few seconds: asked of every file of a search that has more than one name.
const WALK_DEPTH = 6, WALK_FILES = 4000, IDS_MS = 3000, IDS_STALE_MS = 30_000;
const ids = new Map<string, { at: number; files: Map<string, string>; busy?: boolean }>();
// The walk, one folder at a time: it gives the loop back between folders when it is run in slices.
function* walkListed(at: CredentialPlaces): Generator<void, Map<string, string>> {
  const files = new Map<string, string>();
  let seen = 0;
  const nameless = { ...at, dir: undefined, names: false };
  const todo: [string, number][] = [];
  const first = (p: string, depth: number) => todo.push([p, depth]);
  if (at.home) for (const s of STORES) first(join(at.home, s), 0);
  for (const dir of [at.state, at.config]) {
    if (!dir) continue;
    let names: string[] = [];
    try { names = readdirSync(dir); } catch { continue; }
    for (const n of names) first(join(dir, n), 1);
  }
  while (todo.length) {
    const [p, depth] = todo.pop()!;
    if (seen++ >= WALK_FILES) break;
    let st;
    try { st = lstatSync(p); } catch { continue; }
    if (st.isFile()) { if (credentialAt(p, nameless)) files.set(`${st.dev}:${st.ino}`, p); continue; }
    if (!st.isDirectory() || depth > WALK_DEPTH) continue;
    let names: string[] = [];
    try { names = readdirSync(p); } catch { continue; }
    for (const n of names) if (!/^(?:Cache|Code Cache|GPUCache|CacheStorage|Service Worker|ShaderCache|GrShaderCache|cache2)$/.test(n)) todo.push([join(p, n), depth + 1]);
    yield;
  }
  return files;
}
// The listed files by identity. Seen at most a few seconds ago: as it is. Seen less than half a minute ago: as it
// was, and made again in slices between the loop's other work. Not seen for longer, or never: made now, timed (a
// look at a few thousand entries, bounded by WALK_FILES).
function listedFiles(at: CredentialPlaces): Map<string, string> {
  const key = [at.home, at.state, at.config].join("\0");
  const kept = ids.get(key);
  const age = kept ? Date.now() - kept.at : Infinity;
  if (kept && age < IDS_MS) return kept.files;
  if (kept && age < IDS_STALE_MS) {
    if (!kept.busy) {
      kept.busy = true;
      const run = walkListed(at);
      const step = () => {
        const t0 = performance.now();
        let r = run.next();
        while (!r.done && performance.now() - t0 < 4) r = run.next();
        if (r.done) ids.set(key, { at: Date.now(), files: r.value });
        else setTimeout(step, 0);
      };
      setTimeout(step, 0);
    }
    return kept.files;
  }
  const files = timed(() => "the identities of the files that hold credentials", () => { const run = walkListed(at); let r = run.next(); while (!r.done) r = run.next(); return r.value; });
  ids.set(key, { at: Date.now(), files });
  return files;
}
// The places as they really are (the home's own links resolved): where a link's landing is judged.
export const realPlaces = (home: string, own: { state?: string; config?: string } = {}): CredentialPlaces => {
  const real = (p: string) => { try { return realpathSync(p); } catch { return p; } };
  return placesOf(real(home), { ...(own.state ? { state: real(own.state) } : {}), ...(own.config ? { config: real(own.config) } : {}) });
};
export const forgetListed = () => ids.clear();

// A regular file with more than one name that is one of the files credentialAt lists, under whatever name it is
// asked by (a hard link in a project folder to a key): judged by what it is, not by what it is called.
export function linkedCredential(path: string, at: CredentialPlaces): Credential | null {
  if (!isAbsolute(path)) return null;
  let st;
  try { st = statSync(path); } catch { return null; }
  if (!st.isFile() || st.nlink < 2) return null;
  const listed = listedFiles(at).get(`${st.dev}:${st.ino}`);
  if (!listed) return null;
  const p = resolve(path);
  const c = credentialAt(listed, { ...at, dir: undefined, names: false });
  return { path: p, store: listed, what: `${tilde(p, at.home)}, another name for ${tilde(listed, at.home)}, where the owner's credentials are kept`, foreign: true, ...(c?.api ? { api: c.api } : {}) };
}

// Whether a path is another name for one of the listed files, wherever the name stands: a hard link to one, or a
// link that lands in the places listed (what `names` would say of the landing alone is not asked). `at`: the
// places as they really are, links resolved. The answer is marked `foreign`.
export function foreignAt(path: string, at: CredentialPlaces): Credential | null {
  if (!isAbsolute(path)) return null;
  const nameless = { ...at, dir: undefined, names: false };
  let landed: string;
  try { landed = realpathSync(path); } catch { return null; }
  const link = linkedCredential(landed, nameless);
  if (link) return link;
  if (landed !== resolve(path)) { const c = credentialAt(landed, nameless); if (c) return { ...c, foreign: true }; }
  return null;
}

// The stores of the home inside a folder that is not itself in one: what a search of the folder would read.
// The home itself and the folders that hold stores (~/.config, ~/.local/share) name theirs; another folder none.
export function storesUnder(folder: string, home: string): string[] {
  if (!home || !isAbsolute(folder)) return [];
  const f = resolve(folder);
  if (!inside(f, home) && !inside(home, f)) return [];
  return STORES.map((s) => join(home, s)).filter((s) => s !== f && inside(f, s));
}

// The values a credential file holds, to be kept from every model: the value
// of a credential's name (`API_KEY=value`, `"password": "value"`, netrc's
// `password value`), a private key's block, a URL's password, and every value
// or run that looks random (letters and digits mixed). A file that is one word
// is that word. A plain setting (`region = us-east-1`, `NODE_ENV=production`)
// is left as it is: a value kept is replaced everywhere the session sees it.
export function credentialValues(text: string): string[] {
  const out = new Set<string>();
  const add = (v: string | undefined, sure = false) => {
    if (!v) return;
    const t = v.trim().replace(/^["'`]+|["'`,;]+$/g, "");
    if (t.length < 6 || t.length > 16_384 || /^\$\{?\w+\}?$|^<[^>]*>$|^\{\{.*\}\}$|^\*+$/.test(t) || /^(?:true|false|null|none|yes|no)$/i.test(t)) return;
    if (sure || random(t)) out.add(t);
  };
  const body = text.length > 4_000_000 ? text.slice(0, 4_000_000) : text;
  const whole = body.trim();
  // (A token file: one word that is not a setting.)
  if (whole && !/[\s=:]/.test(whole) && whole.length <= 16_384) add(whole, true);
  for (const m of body.matchAll(/-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----/g)) {
    add(m[0], true);
    // (Each line of the block too: a read that numbers its lines splits it.)
    for (const line of m[0].split("\n")) if (!line.startsWith("-----")) add(line, true);
  }
  for (const line of body.split("\n")) {
    const l = line.replace(/\r$/, "");
    if (/^\s*[#;]/.test(l)) continue;
    // `NAME=value`, `name = value`, `export NAME="value"`, `//host/:_authToken=value` (at the first `=`), else
    // `name: value`, `"name": "value",` (at the first `:` that does not open a URL).
    const kv = /^\s*(?:export\s+)?["']?([^"'=#\s][^"'=]*?)["']?\s*=\s*(.*?)\s*$/.exec(l) ?? /^\s*-?\s*["']?([^"':#\s][^"':]*?)["']?\s*:(?!\/\/)\s*(.*?)\s*,?\s*$/.exec(l);
    if (kv && kv[2] && !kv[2].startsWith("{") && !kv[2].startsWith("[")) add(kv[2], secretName(kv[1]!.split(/[:/]/).pop() ?? ""));
    // netrc and its kin: `machine host login user password value`.
    for (const m of l.matchAll(/\b(?:password|passwd|secret|token)\s+(\S+)/gi)) add(m[1], true);
    // A URL's password: `https://user:value@host`.
    for (const m of l.matchAll(/[a-z][a-z0-9+.-]{1,20}:\/\/[^\s:@/]{1,128}:([^\s@/]{1,256})@/gi)) add(m[1], true);
  }
  // Every long run that looks random: a token whatever holds it.
  for (const m of body.matchAll(/[A-Za-z0-9+/=_~.-]{16,}/g)) add(m[0]);
  return [...out];
}
// Letters and digits mixed, and not one word repeated or a dotted name.
const random = (v: string) => /[A-Za-z]/.test(v) && /\d/.test(v) && entropy(v) >= 3 && !/^[A-Za-z_][\w-]*(?:\.[A-Za-z_][\w-]*)+$/.test(v) && !/^v?\d+(?:\.\d+)+(?:[-+.][\w.]+)?$/.test(v);

// A read of a folder that holds the home's stores, said once.
export const storesSaid = (stores: string[], home: string) => stores.slice(0, 3).map((s) => tilde(s, home)).join(", ") + (stores.length > 3 ? ` and ${stores.length - 3} more` : "");
