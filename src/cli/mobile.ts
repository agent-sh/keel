// keel pair | devices | revoke | notify: the phone from a terminal.
//
// The store has one process that writes it: the daemon. While a daemon holds
// the state folder these commands ask it (its address is in the folder's
// lock); they open the store themselves only when no daemon does, and hold
// the folder's claim for as long as they have it open, so none starts in the
// middle. A second process that opens the store read-write and closes it is
// the one that can take the log from under a daemon whose locks were lost
// (src/core/store-files.ts): no command is that process.
import { Database } from "bun:sqlite";
import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { renderSVG, renderUnicodeCompact } from "uqr";
import { claimState, lockedDaemon } from "../admin/daemon.ts";
import { undoCutRestore } from "../admin/storage.ts";
import { Store } from "../core/store.ts";
import { storePath } from "../core/store-files.ts";
import { MobileStore } from "../integrations/mobile/store.ts";
import { pairLink } from "../integrations/mobile/v1.ts";
import { defaultStateDir } from "../core/paths.ts";
import { authHeaders } from "./client.ts";

const stateDirOf = (v?: string) => (v ? resolve(v) : defaultStateDir());

type Device = { id: string; name: string; nolock: unknown; revoked: unknown; push: { registered: boolean; warning?: unknown; unacknowledged?: number } };
type Paired = { code: string; link: string; hermes: string; svg: string };
// What the three commands need, from the daemon or from the store.
type Phone = {
  remembers: boolean; // the address the phone reaches this machine at is kept on the other side (the daemon's)
  publicUrl(): string | undefined;
  pair(url: string, ttl: number): Promise<Paired> | Paired;
  devices(): Promise<Device[]> | Device[];
  revoke(id: string): Promise<boolean> | boolean;
  close(): void;
};

class NoAddress extends Error {}

// The daemon of the folder, asked over its API.
function viaDaemon(base: string): Phone {
  const call = async (method: string, path: string, body?: unknown) => {
    let r: Response;
    try {
      r = await fetch(base + path, { method, headers: { "content-type": "application/json", ...authHeaders() }, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (e) {
      throw new Error(`the daemon at ${base} did not answer: ${(e as Error).message}`);
    }
    const b: any = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, body: b };
  };
  return {
    remembers: true,
    publicUrl: () => undefined,
    pair: async (url, ttl) => {
      const r = await call("POST", "/api/mobile/pair", { ...(url ? { public_url: url } : {}), ttl_seconds: ttl });
      if (r.status === 400 && !url) throw new NoAddress();
      if (!r.ok) throw new Error(String(r.body.error ?? `HTTP ${r.status}`));
      return { code: r.body.code, link: r.body.pair_link, hermes: r.body.hermes_link, svg: r.body.qr_svg };
    },
    devices: async () => {
      const r = await call("GET", "/api/mobile/devices");
      if (!r.ok) throw new Error(String(r.body.error ?? `HTTP ${r.status}`));
      return r.body.devices as Device[];
    },
    revoke: async (id) => {
      const r = await call("DELETE", `/api/mobile/devices/${encodeURIComponent(id)}`);
      if (r.status === 404) return false;
      if (!r.ok) throw new Error(String(r.body.error ?? `HTTP ${r.status}`));
      return true;
    },
    close: () => {},
  };
}

// The store itself, with the folder's claim held: no daemon runs on it. The
// database is opened without a daemon's start-up work (its schema changes,
// its list of the sessions left working); a folder with none gets a store.
function viaStore(state: string, claim: { release: () => void }): Phone {
  let m: MobileStore;
  let db: Database;
  try {
    const path = storePath(state);
    // A restore that was cut is undone first (which can bring the database back).
    if (!existsSync(path)) undoCutRestore(state);
    if (existsSync(path)) {
      db = new Database(path, { strict: true });
      db.exec("PRAGMA busy_timeout = 5000");
      const conn = db;
      m = new MobileStore({ db: conn, migrate: (sql: string) => void conn.exec(sql) });
    } else {
      const store = new Store(state);
      db = store.db;
      m = new MobileStore(store);
    }
  } catch (e) {
    claim.release();
    throw e;
  }
  return {
    remembers: false,
    publicUrl: () => m.setting("public_url") ?? undefined,
    pair: (url, ttl) => {
      m.setPublicUrl(url);
      const code = m.createPairCode(ttl);
      const link = pairLink(url, code);
      return { code, link, hermes: pairLink(url, code, "hermes"), svg: renderSVG(link, { border: 2 }) };
    },
    devices: () => m.devices().map((d) => ({ id: d.id, name: d.name, nolock: d.nolock, revoked: d.revoked, push: m.pushStatus(d.id) })),
    revoke: (id) => !!m.revoke(id),
    close: () => {
      try { db.close(); } finally { claim.release(); }
    },
  };
}

function open(dir?: string): Phone {
  const state = stateDirOf(dir);
  // A daemon holds the folder when it holds the claim, or when the lock file
  // names one that is still there: a daemon from before the claim has none,
  // and a claim can be lost (the kernel drops it when its holder closes any
  // handle of the file). Either way the store is the daemon's to write.
  const held = lockedDaemon(state);
  const claim = held && held.pid !== process.pid ? null : claimState(state);
  if (claim) return viaStore(state, claim);
  const url = (held ?? lockedDaemon(state))?.url;
  if (!url) throw new Error(`${state} is in use (a daemon starting, or a restore): run the command again in a moment`);
  return viaDaemon(url.replace(/\/+$/, ""));
}

async function pair(argv: string[]): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { url: { type: "string" }, ttl: { type: "string", default: "600" }, "state-dir": { type: "string" }, help: { type: "boolean" } } });
  if (values.help) return (console.log("keel pair --url <address the phone reaches this machine at> [--ttl seconds]"), 0);
  const m = open(values["state-dir"]);
  try {
    const url = (values.url ?? process.env.MOBILE_PUBLIC_URL ?? m.publicUrl() ?? "").trim().replace(/\/+$/, "");
    const ttl = Math.min(86_400, Math.max(60, Number(values.ttl) || 600));
    const needs = "keel pair: pass --url (or set MOBILE_PUBLIC_URL) with the address the phone reaches this daemon at";
    // No address here: a daemon uses the one it remembers, and says so when it has none.
    if (url ? !/^https?:\/\/[^\s/]+/.test(url) : !m.remembers) return (console.error(needs), 2);
    let made: Paired;
    try {
      made = await m.pair(url, ttl);
    } catch (e) {
      if (!(e instanceof NoAddress)) throw e;
      return (console.error(needs), 2);
    }
    const svg = join(stateDirOf(values["state-dir"]), "pair-qr.svg");
    writeFileSync(svg, made.svg);
    console.log(renderUnicodeCompact(made.link, { border: 2 }));
    console.log(`Pair link (Keel app): ${made.link}\nFor the Hermes app: ${made.hermes}\nSaved QR SVG: ${svg}\nThe code is good once, for ${ttl} s.`);
    return 0;
  } finally {
    m.close();
  }
}

async function devices(argv: string[]): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { "state-dir": { type: "string" }, help: { type: "boolean" } } });
  if (values.help) return (console.log("keel devices [--state-dir DIR]\n  Lists the paired phones: id, name, whether it was revoked, and its push registration."), 0);
  const m = open(values["state-dir"]);
  try {
    for (const d of await m.devices()) {
      const p = d.push;
      // Names come from the phone: printed as data.
      console.log(`${d.id}  ${JSON.stringify(d.name).padEnd(24)}  nolock=${d.nolock}  revoked=${d.revoked}  push=${p.registered ? "registered" : "none"}${p.warning ? ` (${p.unacknowledged} unconfirmed)` : ""}`);
    }
    return 0;
  } finally {
    m.close();
  }
}

async function revoke(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { "state-dir": { type: "string" }, help: { type: "boolean" } } });
  if (values.help) return (console.log("keel revoke <device id> [--state-dir DIR]\n  Revokes a paired phone (keel devices lists the ids)."), 0);
  if (!positionals[0]) return (console.error("usage: keel revoke <device id>"), 2);
  const m = open(values["state-dir"]);
  try {
    console.log((await m.revoke(positionals[0])) ? "revoked" : "unknown device");
    return 0;
  } finally {
    m.close();
  }
}

async function notify(argv: string[]): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { test: { type: "boolean" }, device: { type: "string" }, bind: { type: "string", default: process.env.KEEL_BIND ?? "127.0.0.1:47960" }, help: { type: "boolean" } } });
  if (values.help) return (console.log("keel notify --test [--device ID] [--bind HOST:PORT]\n  Sends a test push to the paired phones (or one) through the daemon at --bind."), 0);
  if (!values.test) return (console.error("keel notify sends a test push: pass --test"), 2);
  let res: Response;
  try {
    res = await fetch(`http://${values.bind}/api/mobile/test-push`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ device_id: values.device }) });
  } catch (e) {
    console.error(`keel notify: the daemon at ${values.bind} did not answer: ${(e as Error).message}`);
    return 1;
  }
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) return (console.error(`no push was sent (${res.status}): ${JSON.stringify(body.error ?? "")}`), 1);
  let failed = 0;
  for (const p of body.pushes ?? []) {
    if (!p.ok) failed++;
    console.log(`${p.id}  device ${p.device_id}  ${p.ok ? "accepted by the push service; the device row shows when the phone confirms it" : `not sent: ${JSON.stringify(p.error ?? "")}`}`);
  }
  return failed ? 1 : 0;
}

// A refusal (the state folder in use) is one line, not a stack.
const plain = (run: (argv: string[]) => Promise<number>) => async (argv: string[]) => {
  try { return await run(argv); } catch (e) { return (console.error(`keel: ${(e as Error).message}`), 1); }
};
export const mobileCommands = { pair: plain(pair), devices: plain(devices), revoke: plain(revoke), notify: plain(notify) };
