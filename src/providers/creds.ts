// Provider keys. An environment variable wins; else the named keyring entry,
// read through `cred-get` (Secret Service, then systemd-creds). A key is held in
// memory for a few minutes only, so a keyring is not asked once per request (a
// keyring read costs the keyring daemon CPU) and a rotated key is picked up soon.
// A key is never logged, never written, never put in an error.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readText } from "../core/proc.ts";

const TTL = 5 * 60_000;
const cache = new Map<string, { value: string; at: number }>();
const missing = new Map<string, number>();

export type KeySource = { env?: string; cred?: string };

// KEEL_CRED_GET names the helper to run instead (a test or a scratch daemon
// points it at a program that prints nothing, so the owner's own credential
// helper is never run for it).
function credGet(): string {
  if (process.env.KEEL_CRED_GET) return process.env.KEEL_CRED_GET;
  const local = join(homedir(), ".local/bin/cred-get");
  return existsSync(local) ? local : "cred-get";
}

// Keys the owner saved through Keel live in the system keyring (Secret
// Service, macOS Keychain, Windows Credential Manager) under this service.
export const keyringService = () => process.env.KEEL_KEYRING_SERVICE || "keel-bun";

async function ownKeyring(name: string): Promise<string | null> {
  try {
    return (await Bun.secrets.get({ service: keyringService(), name }))?.trim() || null;
  } catch {
    return null; // no keyring on this machine (a headless box): the next source answers
  }
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
  const p = Bun.spawn([bin, name], { stdin: "ignore", stdout: "pipe", stderr: "ignore", cwd: homedir() });
  const timer = setTimeout(() => p.kill(), 20_000);
  const out = (await readText(p.stdout)).split("\n")[0]!.trim();
  clearTimeout(timer);
  await p.exited;
  return out;
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

// How long a source found empty is left alone before a request for its provider reads it again.
export const MISSING_RECHECK_MS = TTL;

export function forget(src: KeySource) {
  if (src.cred) cache.delete(src.cred);
}

export const shown = (src: KeySource) =>
  src.env && process.env[src.env] ? `$${src.env}` : src.cred ? `keyring ${src.cred}` : "no key";

// A one-way fingerprint of what identifies an account and endpoint: the
// endpoint, the key source, and an environment key's value (a keyring entry is
// named, not read, so this never costs a keyring read).
export function fingerprint(...parts: (string | undefined)[]): string {
  return new Bun.CryptoHasher("sha256").update(parts.map((p) => p ?? "").join("\0")).digest("hex").slice(0, 16);
}

export const sourceIdentity = (src: KeySource) =>
  src.env && process.env[src.env] ? `env:${src.env}:${process.env[src.env]!.trim()}` : src.cred ? `cred:${src.cred}` : "";
