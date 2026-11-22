// Shared parts of the client commands: finding the daemon, calling its API,
// parsing options with a usage on error, printing model text safely, and the
// exit codes of every client command.
import { fstatSync } from "node:fs";
import { join } from "node:path";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { lockedDaemon, servicedDaemon } from "../admin/daemon.ts";
import { defaultStateDir } from "../core/paths.ts";

export const EXIT = { ok: 0, owner: 2, error: 3, timeout: 124, sigint: 130, sigterm: 143 } as const;
export const DEFAULT_URL = "http://127.0.0.1:47960";

export class ApiError extends Error {
  // `unreached`: the daemon took no connection, so it read nothing of the request.
  // `refused`: a draining daemon turned the request away at the door, before any route read it.
  // `held`: an approval's answer was not taken and its card is still open (an allow of a request that is read first).
  constructor(message: string, readonly status: number, readonly unreached = false, readonly refused = false, readonly held = false) { super(message); }
}

// Text from a model, a tool or a prompt never reaches a terminal raw: escape
// sequences and control characters other than newline and tab are removed.
export const clean = (s: unknown) =>
  String(s ?? "").replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[@-_]/g, "").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
// One line: newlines shown as \n.
export const line = (s: unknown) => clean(String(s ?? "").replace(/\r?\n/g, "\\n").replace(/\t/g, " "));

export type Found = { url: string; from: "flag" | "env" | "lock" | "service" | "default"; client?: boolean; stateDir: string };

// --url, then KEEL_URL, then the address the daemon of the state folder
// recorded in its lock, then the service's daemon, then the default bind.
export function findDaemon(v: { url?: string; "state-dir"?: string }): Found {
  const stateDir = v["state-dir"] ? join(v["state-dir"]) : defaultStateDir();
  const trim = (u: string) => u.replace(/\/+$/, "");
  if (v.url) return { url: trim(v.url), from: "flag", stateDir };
  if (process.env.KEEL_URL) return { url: trim(process.env.KEEL_URL), from: "env", stateDir };
  const held = lockedDaemon(stateDir);
  if (held?.url) return { url: trim(held.url), from: "lock", client: held.client, stateDir };
  // No daemon in the default folder: the one the service manager runs, if any.
  // Only when no state folder was named (flag or KEEL_STATE_DIR): a command
  // given its own folder never reaches another folder's daemon.
  const svc = v["state-dir"] || process.env.KEEL_STATE_DIR ? undefined : servicedDaemon();
  if (svc) return { url: trim(svc.url), from: "service", stateDir: svc.state_dir };
  return { url: DEFAULT_URL, from: "default", stateDir };
}

// A daemon reached through a tunnel or from another account needs its access
// token (KEEL_TOKEN, from the daemon's <state>/api-token).
export const authHeaders = (): Record<string, string> => (process.env.KEEL_TOKEN ? { authorization: `Bearer ${process.env.KEEL_TOKEN}` } : {});

// An address where another program answers is not a daemon that said no:
// before a refusal is shown as the daemon's, the address is asked for the
// daemon's own health answer (once per address, and only after a refusal).
const keelAt = new Map<string, Promise<boolean>>();
const isKeel = (base: string) =>
  keelAt.get(base) ??
  keelAt.set(base, fetch(base + "/api/health", { signal: AbortSignal.timeout(1500) }).then(async (r) => r.ok && typeof ((await r.json()) as any)?.pid === "number").catch(() => false)).get(base)!;
// The words for a refused call: the daemon's own, or that no daemon is there.
export async function refusal(base: string, r: Response, body: any): Promise<string> {
  if (await isKeel(base)) return body?.error ?? `HTTP ${r.status}`;
  return `no Keel daemon answers at ${base}: another program does (pass --url, set KEEL_URL, or give the daemon's --state-dir)`;
}

export class Client {
  constructor(readonly base: string) {}

  async call<T = any>(method: string, path: string, body?: unknown, raw?: { body: BodyInit; type: string }): Promise<T> {
    let r: Response;
    try {
      r = await fetch(this.base + path, {
        method,
        headers: { "content-type": raw?.type ?? "application/json", ...authHeaders() },
        body: raw ? raw.body : body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw new ApiError(`no daemon answers at ${this.base} (start one with \`keel serve\`, or pass --url)`, 0, /ConnectionRefused|ECONNREFUSED/.test(String((e as any)?.code)));
    }
    const b = (await r.json().catch(() => ({}))) as any;
    if (!r.ok) throw new ApiError(await refusal(this.base, r, b), r.status, false, r.status === 503 && b?.draining === true, r.status === 409 && Array.isArray(b?.hold));
    return b as T;
  }
  get = <T = any>(path: string) => this.call<T>("GET", path);
  post = <T = any>(path: string, body?: unknown) => this.call<T>("POST", path, body ?? {});
  put = <T = any>(path: string, body?: unknown) => this.call<T>("PUT", path, body ?? {});
  patch = <T = any>(path: string, body?: unknown) => this.call<T>("PATCH", path, body ?? {});
  del = <T = any>(path: string) => this.call<T>("DELETE", path);

  async alive(): Promise<boolean> {
    try {
      const r = await fetch(this.base + "/api/health", { signal: AbortSignal.timeout(1500) });
      return r.ok;
    } catch { return false; }
  }

  // A full id from any prefix that names one session.
  async resolve(id: string): Promise<any> {
    return (await this.get<{ session: any }>(`/api/cli/resolve?id=${encodeURIComponent(id)}`)).session;
  }

  url(sessionId: string) { return `${this.base}/s/${sessionId}`; }
}

// Options every client command takes.
export const COMMON = {
  url: { type: "string" },
  "state-dir": { type: "string" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

type Options = NonNullable<ParseArgsConfig["options"]>;

// A command: its usage is its --help, and a bad option prints it (exit 3).
export function command(name: string, usage: string, options: Options, run: (v: any, pos: string[], c: Client, found: Found) => Promise<number>, opts: { daemon?: boolean } = {}) {
  return async (argv: string[]): Promise<number> => {
    let parsed;
    try {
      parsed = parseArgs({ args: argv, allowPositionals: true, strict: true, options: { ...COMMON, ...options } });
    } catch (e) {
      console.error(`keel ${name}: ${(e as Error).message.replace(/\. To specify a positional.*$/s, "")}\n\n${usage}`);
      return EXIT.error;
    }
    const { values, positionals } = parsed as { values: any; positionals: string[] };
    if (values.help) return (console.log(usage), EXIT.ok);
    const found = findDaemon(values);
    const c = new Client(found.url);
    try {
      return await run(values, positionals, c, found);
    } catch (e) {
      console.error(`keel ${name}: ${e instanceof ApiError || (e as any)?.status ? (e as Error).message : (e as Error).stack ?? e}`);
      return EXIT.error;
    }
  };
}

export const usageError = (name: string, message: string, usage: string) => (console.error(`keel ${name}: ${message}\n\n${usage}`), EXIT.error);

// Standard input, when it is a pipe or a file (never a terminal or /dev/null,
// so a run started without input does not wait on it).
export async function pipedStdin(): Promise<string | null> {
  try {
    const st = fstatSync(0);
    if (!st.isFIFO() && !st.isFile()) return null;
  } catch { return null; }
  return await Bun.stdin.text();
}

export const out = (s: string) => process.stdout.write(s);
export const printJson = (v: unknown) => console.log(JSON.stringify(v, null, 2));

export const ago = (ms: number) => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`;
};

// Open a URL in the browser: KEEL_BROWSER, else the desktop's opener.
export function openUrl(url: string, activationToken?: string): boolean {
  const cmd = process.env.KEEL_BROWSER ? [...process.env.KEEL_BROWSER.split(" ").filter(Boolean), url] : [process.platform === "darwin" ? "open" : "xdg-open", url];
  try {
    const env = activationToken ? { ...process.env, XDG_ACTIVATION_TOKEN: activationToken } : undefined;
    Bun.spawn(cmd, { stdio: ["ignore", "ignore", "ignore"], env }).unref();
    return true;
  } catch { return false; }
}

// Files for a prompt: images inline (what a model reads as an image), every
// other file uploaded once by content and sent as a reference.
const IMAGE = /^image\/(png|jpeg|gif|webp)$/;
const IMAGE_MAX = 3_750_000;
export async function promptFiles(c: Client, paths: string[]): Promise<{ images: any[]; draftImages: any[]; files: any[] }> {
  const images: any[] = [], draftImages: any[] = [], files: any[] = [];
  for (const p of paths) {
    const f = Bun.file(p);
    if (!(await f.exists())) throw new ApiError(`no such file: ${p}`, 400);
    const type = f.type.split(";")[0]!;
    const bytes = new Uint8Array(await f.arrayBuffer());
    const name = p.split("/").pop() || "file";
    if (IMAGE.test(type) && bytes.byteLength <= IMAGE_MAX) {
      const data = Buffer.from(bytes).toString("base64");
      images.push({ type: "image", media_type: type, data });
      draftImages.push({ name, mime: type, data });
    } else {
      files.push(await c.call("POST", `/api/attachments?name=${encodeURIComponent(name)}`, undefined, { body: bytes, type: type || "application/octet-stream" }));
    }
  }
  return { images, draftImages, files };
}
