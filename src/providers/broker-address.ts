// The launcher opts in by naming its trusted EnvironmentFile. Only the port
// of the provider's existing loopback URL may change, not where credentials go.
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";

const READ_MS = 5_000;
const MAX_BYTES = 256 * 1024;

export function brokerEnvFile() {
  const file = process.env.KEEL_PROVIDER_ENV_FILE;
  return file && isAbsolute(file) ? file : undefined;
}

export function loopback(value: string | undefined): URL | undefined {
  if (!value) return;
  try {
    const u = new URL(value);
    if ((u.protocol === "http:" || u.protocol === "https:") && !u.username && !u.password && !u.search && !u.hash &&
        (u.hostname === "localhost" || u.hostname === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(u.hostname))) return u;
  } catch {}
}

// Only simple EnvironmentFile assignments are supported. Do not read a line
// inside a multiline value as a new assignment, or interpret shell syntax.
function brokerSetting(text: string, key: string): string | undefined {
  let value: string | undefined;
  if (/[\u0000\uFEFF]/.test(text)) return;
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || t.startsWith(";")) continue;
    // Reject continuations, even in other variables in the file.
    if (t.endsWith("\\")) return;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const name = t.slice(0, eq).trim();
    const raw = t.slice(eq + 1).trim();
    const quote = raw[0] === '"' || raw[0] === "'" ? raw[0] : undefined;
    if (quote && (raw.indexOf(quote, 1) !== raw.length - 1 || raw.length < 2 || (quote === '"' && raw.includes("\\")))) return;
    if (name === key) value = quote ? raw.slice(1, -1) : raw;
  }
  // No escapes, interpolation, whitespace or shell operators in the address.
  return value && !/[\s\\$`#?]/.test(value) ? value : undefined;
}

async function readSetting(file: string, key: string) {
  const fd = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const st = await fd.stat();
    if (!st.isFile() || st.size > MAX_BYTES) return;
    const buf = Buffer.alloc(st.size + 1);
    const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
    if (bytesRead === st.size) return brokerSetting(buf.toString("utf8", 0, bytesRead), key);
  } finally {
    await fd.close();
  }
}

const port = (u: URL) => u.port || (u.protocol === "https:" ? "443" : "80");

export class BrokerAddress {
  private lastRead = -Infinity;
  private override?: string;
  private movedFrom?: string;
  private refused?: string;

  constructor(readonly key: string, readonly identity: string | undefined) {}
  get value() { return this.override ?? this.identity; }

  noteRefusal(error: unknown) {
    const origin = error instanceof Error ? refusedOrigins.get(error) : undefined;
    if (origin && origin === loopback(this.value)?.origin) this.refused = origin;
  }

  // Called only by the outage probe, after fetch confirmed a connection refusal
  // at the current address. Five seconds spans the early 1 s and 2 s probes.
  async reread(file: string | undefined) {
    if (!file || !this.refused || performance.now() - this.lastRead < READ_MS) return;
    const old = loopback(this.value);
    if (!old || old.origin !== this.refused || proxied(old)) return;
    this.lastRead = performance.now();
    const next = loopback(await readSetting(file, this.key).catch(() => undefined));
    if (this.refused !== old.origin || loopback(this.value)?.origin !== old.origin) return;
    if (!next || old.hostname !== next.hostname || old.protocol !== next.protocol || old.pathname !== next.pathname || old.port === next.port) return;
    // Rebuild the address used by the next transport. In-flight calls and
    // the provider's credentials are not changed.
    this.override = next.origin + (this.value!.endsWith("/") ? next.pathname : next.pathname.replace(/\/$/, ""));
    this.movedFrom ??= port(old);
  }

  answered(base: string | undefined): string | undefined {
    if (base !== this.value) return;
    this.refused = undefined;
    if (!this.movedFrom) return;
    const from = this.movedFrom;
    this.movedFrom = undefined;
    const to = port(loopback(base)!);
    if (from !== to) return `the broker moved from port ${from} to port ${to}`;
  }
}

// Only evidence from a real fetch is used, never a matching provider message.
export const refusedOrigins = new WeakMap<Error, string>();

// Bun uses ambient proxies even when fetch is passed an empty proxy string.
// Only trust refusal evidence from a direct request, including after a port move.
function proxied(u: URL): boolean {
  const env = process.env;
  if (![env.HTTP_PROXY, env.http_proxy, env.HTTPS_PROXY, env.https_proxy, env.ALL_PROXY, env.all_proxy].some(Boolean)) return false;
  const bypass = [env.NO_PROXY, env.no_proxy].filter((v): v is string => v !== undefined);
  return !bypass.length || !bypass.every((v) => v.split(",").some((h) => h.trim() === "*" || h.trim() === u.hostname));
}

export function directBrokerOrigin(url: string) {
  if (!brokerEnvFile()) return;
  const u = loopback(url.split("?", 1)[0]);
  if (u && !proxied(u)) return u.origin;
}
