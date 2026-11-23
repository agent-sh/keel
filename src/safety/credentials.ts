// Where credentials are kept, one list for every way a session reads: its file
// tools (Read, Grep, Glob and their kin in each family's tool set), the reading
// commands of its shell (cat, head, grep -r over the home), and what its sandbox
// hides (sandbox-view.ts builds its stores from STORES). Pure: paths in, the
// store out; nothing here looks at the disk.
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
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { contains as inside } from "../core/paths.ts";
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
  // Model and tool sign-ins.
  ".cache/huggingface/token", ".cache/huggingface/stored_tokens", ".config/github-copilot",
  ".claude/.credentials.json", ".codex/auth.json", ".gemini/oauth_creds.json", ".gemini/google_accounts.json", ".local/share/opencode/auth.json",
  // Browser and mail profiles: cookies, saved passwords, session tokens.
  ".mozilla", ".thunderbird", ".config/google-chrome", ".config/google-chrome-beta", ".config/chromium", ".config/BraveSoftware", ".config/microsoft-edge", ".config/vivaldi",
  "snap/firefox", "snap/chromium", ".var/app/org.mozilla.firefox", ".var/app/com.google.Chrome",
  "Library/Application Support/Google/Chrome", "Library/Application Support/Firefox", "Library/Cookies",
] as const;

// In ~/.ssh, what holds no secret: public keys, the hosts it knows, its client settings.
const SSH_PUBLIC = /^(?:.+\.pub|known_hosts(?:\.old)?|config|authorized_keys2?)$/;

// Keel's own secrets in its state folder and in its config folder, by name.
// The rest of either folder (a session's outputs and artifacts, a worktree Keel
// made, its skills and instruction files) is not a credential.
export const KEEL_STATE = /^(?:api-token|secret-key|mcp-bind\.key|mcp-oauth\.json|ssh(?:\/.*)?|keel\.db(?:-wal|-shm|-journal)?|log-pages\.db(?:-wal|-shm)?)$/;
export const KEEL_CONFIG = /^(?:providers\.toml|mcp\.json|drive\.json|[\w.-]*auth[\w.-]*\.json|endpoints(?:\/.*)?)(?:\.prev)?$/;

// System files that hold credentials.
const SYSTEM = /^\/etc\/(?:shadow|gshadow|shadow-|gshadow-|ssh\/ssh_host_[\w-]+_key)$/;

// A name that is what it stands for, not a credential: an example, a template.
const EXAMPLE = /\.(?:example|sample|template|tmpl|dist|defaults?|schema|md|txt\.example)$/i;

// A file whose name says it holds a credential, wherever it is.
export function credentialName(name: string): boolean {
  const b = name.toLowerCase();
  if (!b || EXAMPLE.test(b) || b.endsWith(".pub")) return false;
  // Environment files: `.env`, `.env.local`, `prod.env`.
  if (b === ".env" || b.startsWith(".env.") || (b.endsWith(".env") && b.length > 4)) return true;
  // Private keys and keystores.
  if (/^id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?(?:[-_.][\w-]*)?$/.test(b)) return true;
  if (/\.(?:key|p12|pfx|jks|keystore|kdbx|ppk)$/.test(b)) return true;
  if (/^(?:priv(?:ate)?[-_]?key|key|privkey|[\w.-]+[-_.](?:priv(?:ate)?[-_]?key|key))\.pem$/.test(b)) return true;
  // Token and credential files.
  if (/^\.?(?:netrc|pgpass|git-credentials|htpasswd|vault-token)$/.test(b)) return true;
  if (/^(?:\.?credentials|secrets?)(?:\.(?:json|ya?ml|toml|ini|env|txt|conf|cfg|xml))?$/.test(b) || b === "token" || b === "token.json") return true;
  if (/^client_secrets?[\w.-]*\.json$/.test(b) || /^service[-_]?account[\w.-]*\.json$/.test(b) || /^application_default_credentials\.json$/.test(b)) return true;
  if (/[-_.](?:secrets?|credentials?)\.(?:json|ya?ml|toml|ini|env|conf|cfg)$/.test(b)) return true;
  if (/^kubeconfig(?:[-_.][\w.-]*)?$/.test(b) || /\.tfstate(?:\.backup)?$/.test(b)) return true;
  return false;
}

export type Credential = { path: string; store: string; what: string };
// `own`: Keel's state and config folders, where the daemon runs from.
export type CredentialPlaces = { home: string; state?: string; config?: string };

const tilde = (p: string, home: string) => (p === home ? "~" : inside(home, p) ? `~/${p.slice(home.length + 1)}` : p);

// The credential a path is, or is in. The path is absolute; links are the caller's to resolve (it asks for the
// path as named and for where it lands).
export function credentialAt(path: string, at: CredentialPlaces): Credential | null {
  if (!isAbsolute(path)) return null;
  const p = resolve(path);
  const home = at.home;
  if (SYSTEM.test(p)) return { path: p, store: p, what: `${p}, a system file that holds credentials` };
  if (at.state && inside(at.state, p) && p !== at.state && KEEL_STATE.test(p.slice(at.state.length + 1)))
    return { path: p, store: p, what: `${tilde(p, home)}, one of Keel's own secrets (its token, its keys, its sessions' store or its sign-ins)` };
  if (at.config && inside(at.config, p) && p !== at.config && KEEL_CONFIG.test(p.slice(at.config.length + 1)))
    return { path: p, store: p, what: `${tilde(p, home)}, Keel's own provider keys or sign-ins` };
  if (home && inside(home, p) && p !== home) {
    const rel = p.slice(home.length + 1);
    for (const s of STORES) {
      if (rel !== s && !rel.startsWith(s + "/")) continue;
      if (s === ".ssh" && rel !== s && SSH_PUBLIC.test(rel.slice(s.length + 1))) break;
      const store = join(home, s);
      return { path: p, store, what: `${tilde(p, home)}, ${rel === s ? "" : `in ${tilde(store, home)}, `}where the owner's credentials are kept` };
    }
  }
  const name = basename(p);
  if (credentialName(name)) return { path: p, store: p, what: `${tilde(p, home)}, a file that holds credentials by its name` };
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
