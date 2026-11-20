// keel pair | devices | revoke | notify: the phone from a terminal. Pairing and
// the device list open the store directly (it is safe beside a running daemon);
// a test push asks the daemon, which holds the push key.
import { Database } from "bun:sqlite";
import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { renderSVG, renderUnicodeCompact } from "uqr";
import { Store } from "../core/store.ts";
import { MobileStore } from "../integrations/mobile/store.ts";
import { pairLink } from "../integrations/mobile/v1.ts";
import { defaultStateDir } from "../core/paths.ts";

const stateDirOf = (v?: string) => (v ? resolve(v) : defaultStateDir());
// The daemon may be running: open the database without the daemon's start-up
// work (which resets the phase of working sessions).
function open(dir?: string): MobileStore {
  const path = join(stateDirOf(dir), "keel.db");
  if (!existsSync(path)) return new MobileStore(new Store(stateDirOf(dir)));
  const db = new Database(path, { strict: true });
  db.exec("PRAGMA busy_timeout = 5000");
  return new MobileStore({ db, migrate: (sql: string) => void db.exec(sql) });
}

async function pair(argv: string[]): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { url: { type: "string" }, ttl: { type: "string", default: "600" }, "state-dir": { type: "string" }, help: { type: "boolean" } } });
  if (values.help) return (console.log("keel pair --url <address the phone reaches this machine at> [--ttl seconds]"), 0);
  const m = open(values["state-dir"]);
  const url = (values.url ?? process.env.MOBILE_PUBLIC_URL ?? m.setting("public_url") ?? "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^\s/]+/.test(url)) {
    console.error("keel pair: pass --url (or set MOBILE_PUBLIC_URL) with the address the phone reaches this daemon at");
    return 2;
  }
  m.setPublicUrl(url);
  const ttl = Math.min(86_400, Math.max(60, Number(values.ttl) || 600));
  const code = m.createPairCode(ttl);
  const link = pairLink(url, code);
  const svg = join(stateDirOf(values["state-dir"]), "pair-qr.svg");
  writeFileSync(svg, renderSVG(link, { border: 2 }));
  console.log(renderUnicodeCompact(link, { border: 2 }));
  console.log(`Pair link (Keel app): ${link}\nFor the Hermes app: ${pairLink(url, code, "hermes")}\nSaved QR SVG: ${svg}\nThe code is good once, for ${ttl} s.`);
  return 0;
}

async function devices(argv: string[]): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { "state-dir": { type: "string" } } });
  const m = open(values["state-dir"]);
  for (const d of m.devices()) {
    const p = m.pushStatus(d.id);
    // Names come from the phone: printed as data.
    console.log(`${d.id}  ${JSON.stringify(d.name).padEnd(24)}  nolock=${d.nolock}  revoked=${d.revoked}  push=${p.registered ? "registered" : "none"}${p.warning ? ` (${p.unacknowledged} unconfirmed)` : ""}`);
  }
  return 0;
}

async function revoke(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { "state-dir": { type: "string" } } });
  if (!positionals[0]) return (console.error("usage: keel revoke <device id>"), 2);
  console.log(open(values["state-dir"]).revoke(positionals[0]) ? "revoked" : "unknown device");
  return 0;
}

async function notify(argv: string[]): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { test: { type: "boolean" }, device: { type: "string" }, bind: { type: "string", default: process.env.KEEL_BIND ?? "127.0.0.1:47960" } } });
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

export const mobileCommands = { pair, devices, revoke, notify };
