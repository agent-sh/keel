// Provider keys. An environment variable wins; else the named keyring entry,
// read through `cred-get` (Secret Service, then systemd-creds). A key is held in
// memory for a few minutes only, so a keyring is not asked once per request (a
// keyring read costs the keyring daemon CPU) and a rotated key is picked up soon.
// A key is never logged, never written, never put in an error.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { outputOf } from "../core/proc.ts";
import { homeDir } from "../core/paths";

const TTL = 5 * 60_000;
const cache = new Map<string, { value: string; at: number }>();
const missing = new Map<string, number>();

export type KeySource = { env?: string; cred?: string };

// KEEL_CRED_GET names the helper to run instead (a test or a scratch daemon
// points it at a program that prints nothing, so the owner's own credential
// helper is never run for it).
function credGet(): string {
  if (process.env.KEEL_CRED_GET) return process.env.KEEL_CRED_GET;
  const local = join(homeDir(), ".local/bin/cred-get");
  return existsSync(local) ? local : "cred-get";
}

// Keys the owner saved through Keel live in the system keyring (Secret
// Service, macOS Keychain, Windows Credential Manager) under this service.
export const keyringService = () => process.env.KEEL_KEYRING_SERVICE || "keel-bun";

// A headless Linux box (no display) has no one to answer a keyring's unlock
// prompt: Bun.secrets.get on a locked collection then waits on that prompt and
// never answers. Verified against a scratch Secret Service with a locked
// collection and no display: the read did not return in 8 s, unlocked it returned
// in milliseconds.
export const headless = (): boolean =>
  process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;

export const KEYRING_WAIT_MS = 1500;

// The keyring read, replaceable by a test.
export const keyringRead = {
  get: (service: string, name: string): Promise<string | null> => Bun.secrets.get({ service, name }),
};

// Entries whose last read did not answer in time: the keyring is locked.
const locked = new Set<string>();
const reading = new Map<string, Promise<string | null>>();

function readOnce(name: string): Promise<string | null> {
  let p = reading.get(name);
  if (!p) {
    p = Promise.resolve()
      .then(() => keyringRead.get(keyringService(), name))
      .then((v) => v?.trim() || null, () => null) // no keyring on this machine: the next source answers
      .finally(() => reading.delete(name));
    reading.set(name, p);
  }
  return p;
}

async function ownKeyring(name: string): Promise<string | null> {
  const read = readOnce(name);
  if (!headless()) return read;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((r) => { timer = setTimeout(() => r("late"), KEYRING_WAIT_MS); });
  const got = await Promise.race([read, late]);
  clearTimeout(timer);
  if (got !== "late") { locked.delete(name); return got; }
  locked.add(name);
  // The unlock may come later: a read that ends with a value then fills the cache.
  void read.then((v) => {
    if (v && locked.delete(name)) { cache.set(name, { value: v, at: Date.now() }); missing.delete(name); }
  });
  return null;
}

// Saves a key to the system keyring; the value is never written anywhere else.
export async function saveKey(name: string, value: string) {
  await Bun.secrets.set({ service: keyringService(), name, value });
  cache.delete(name);
  missing.delete(name);
}

export async function deleteKey(name: string): Promise<boolean> {
  cache.delete(name);
  try { return await Bun.secrets.delete({ service: keyringService(), name }); } catch { return false; }
}

// The cred-get helper, when this machine has one (another store behind one command).
async function helper(name: string): Promise<string> {
  const bin = credGet();
  if (bin === "cred-get" && !Bun.which("cred-get")) return "";
  const p = Bun.spawn([bin, name], { stdin: "ignore", stdout: "pipe", stderr: "ignore", cwd: homeDir() });
  const timer = setTimeout(() => p.kill(), locked.has(name) ? KEYRING_WAIT_MS : 20_000);
  const { out } = await outputOf(p);
  clearTimeout(timer);
  return out.split("\n")[0]!.trim();
}

// The key, or null when no source holds one: the variable, else the keyring
// entry (Keel's own keyring service, then the cred-get helper).
export async function key(src: KeySource): Promise<string | null> {
  if (src.env && process.env[src.env]) return process.env[src.env]!.trim();
  if (!src.cred) return null;
  const hit = cache.get(src.cred);
  if (hit && Date.now() - hit.at < TTL) return hit.value;
  const out = (await ownKeyring(src.cred)) ?? (await helper(src.cred));
  if (!out) {
    missing.set(src.cred, Date.now());
    return null;
  }
  missing.delete(src.cred);
  cache.set(src.cred, { value: out, at: Date.now() });
  return out;
}

// Whether a source can be expected to answer, without reading the value: an
// environment variable, or a keyring entry whose last read did not come back
// empty (one never read counts: its first read decides).
export function configured(src: KeySource): boolean {
  if (src.env && process.env[src.env]) return true;
  if (!src.cred) return false;
  return !missing.has(src.cred);
}

// Reads again a keyring entry last found empty, when that was at least
// `olderThanMs` ago: a key saved outside Keel since, or a keyring that was
// locked then, makes the source configured again.
export async function recheck(src: KeySource, olderThanMs = 0): Promise<void> {
  if (!src.cred || (src.env && process.env[src.env])) return;
  const m = missing.get(src.cred);
  if (m !== undefined && Date.now() - m >= olderThanMs) await key(src);
}

// The first look for a key nobody has read yet (configured() counts it as
// there until then): after it, whether the source holds a key is known. One
// look at a time for an entry, however many ask.
const looking = new Map<string, Promise<void>>();
export function look(src: KeySource): Promise<void> {
  if (!src.cred || (src.env && process.env[src.env]) || cache.has(src.cred) || missing.has(src.cred)) return Promise.resolve();
  const cred = src.cred;
  let p = looking.get(cred);
  if (!p) {
    p = key(src).then(() => {}, () => {}).finally(() => looking.delete(cred));
    looking.set(cred, p);
  }
  return p;
}

// Nobody has read this source's keyring entry yet: no look has ended.
export const unread = (src: KeySource): boolean => !!src.cred && !(src.env && process.env[src.env]) && !cache.has(src.cred) && !missing.has(src.cred);

// How long a source found empty is left alone before a request for its provider reads it again.
export const MISSING_RECHECK_MS = TTL;

export function forget(src: KeySource) {
  if (src.cred) cache.delete(src.cred);
}

export const shown = (src: KeySource) =>
  src.env && process.env[src.env] ? `$${src.env}` : src.cred ? (locked.has(src.cred) ? `keyring ${src.cred} is locked` : `keyring ${src.cred}`) : "no key";

// A one-way fingerprint of what identifies an account and endpoint: the
// endpoint, the key source, and an environment key's value (a keyring entry is
// named, not read, so this never costs a keyring read).
export function fingerprint(...parts: (string | undefined)[]): string {
  return new Bun.CryptoHasher("sha256").update(parts.map((p) => p ?? "").join("\0")).digest("hex").slice(0, 16);
}

export const sourceIdentity = (src: KeySource) =>
  src.env && process.env[src.env] ? `env:${src.env}:${process.env[src.env]!.trim()}` : src.cred ? `cred:${src.cred}` : "";
