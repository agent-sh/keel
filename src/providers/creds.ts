// Provider keys. An environment variable wins; else the named keyring entry,
// read through `cred-get` (Secret Service, then systemd-creds). A key is held in
// memory for a few minutes only, so a keyring is not asked once per request (a
// keyring read costs the keyring daemon CPU) and a rotated key is picked up soon.
// A key is never logged, never written, never put in an error.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const TTL = 5 * 60_000;
const cache = new Map<string, { value: string; at: number }>();
const missing = new Map<string, number>();

export type KeySource = { env?: string; cred?: string };

function credGet(): string {
  const local = join(homedir(), ".local/bin/cred-get");
  return existsSync(local) ? local : "cred-get";
}

// The key, or null when no source holds one.
export async function key(src: KeySource): Promise<string | null> {
  if (src.env && process.env[src.env]) return process.env[src.env]!.trim();
  if (!src.cred) return null;
  const hit = cache.get(src.cred);
  if (hit && Date.now() - hit.at < TTL) return hit.value;
  const p = Bun.spawn([credGet(), src.cred], { stdin: "ignore", stdout: "pipe", stderr: "ignore", cwd: homedir() });
  const timer = setTimeout(() => p.kill(), 20_000);
  const out = (await new Response(p.stdout).text()).split("\n")[0]!.trim();
  clearTimeout(timer);
  await p.exited;
  if (!out) {
    missing.set(src.cred, Date.now());
    return null;
  }
  cache.set(src.cred, { value: out, at: Date.now() });
  return out;
}

// Whether a source can be expected to answer, without reading the value: an
// environment variable, or a keyring entry not seen missing lately.
export function configured(src: KeySource): boolean {
  if (src.env && process.env[src.env]) return true;
  if (!src.cred) return false;
  const m = missing.get(src.cred);
  return !m || Date.now() - m > TTL;
}

export function forget(src: KeySource) {
  if (src.cred) cache.delete(src.cred);
}

export const shown = (src: KeySource) =>
  src.env && process.env[src.env] ? `$${src.env}` : src.cred ? `keyring ${src.cred}` : "no key";
