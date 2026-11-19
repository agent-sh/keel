#!/usr/bin/env bun
// A stand-in for the Hermes gateway's phone socket (one JSON line in, one out,
// the gateway's own answers), for the phone e2e. It never reaches a real phone:
// with PHONE_ADB set (an emulator serial) it acts on that Android emulator
// through adb, else on a fixed screen. Usage: phone-gateway.ts <socket> <state.json>
// State (the test writes it; the gateway reads it on every request):
//   { armed, hold?, stop?, calls: [args], statuses: n }
// hold: the next command waits until the test writes stop: true (the owner's Stop
// on the phone), then control is disarmed and the call ends.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";

const [socket, file] = [process.argv[2]!, process.argv[3]!];
const serial = process.env.PHONE_ADB;
const read = () => JSON.parse(readFileSync(file, "utf8"));
const write = (s: any) => writeFileSync(file, JSON.stringify(s, null, 2));

const run = (args: string[]) => {
  const r = Bun.spawnSync(["adb", "-s", serial!, ...args], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`adb ${args.join(" ")}: ${r.stderr.toString().trim()}`);
  return r.stdout;
};
const adb = (args: string[]) => run(args).toString();

const unxml = (t: string) => t.replace(/&(amp|lt|gt|quot|apos|#\d+);/g, (_, e) => ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" } as Record<string, string>)[e] ?? String.fromCharCode(Number(e.slice(1))));

type El = { i: number; role: string; text: string; id: string; bounds: number[]; clickable: boolean; editable: boolean; scrollable: boolean };
let last: El[] = [];

// The screen's elements from uiautomator, indexed as phone_state indexes them.
function screen(): El[] {
  if (!serial) return [{ i: 0, role: "button", text: "Settings", id: "settings", bounds: [0, 0, 100, 100], clickable: true, editable: false, scrollable: false }];
  adb(["shell", "uiautomator", "dump", "/sdcard/keel-ui.xml"]);
  const xml = adb(["exec-out", "cat", "/sdcard/keel-ui.xml"]);
  const out: El[] = [];
  for (const m of xml.matchAll(/<node ([^>]*?)\/?>/g)) {
    const a = Object.fromEntries([...m[1]!.matchAll(/([\w-]+)="([^"]*)"/g)].map((x) => [x[1], unxml(x[2]!)]));
    const text = a.text || a["content-desc"] || "";
    const clickable = a.clickable === "true", editable = /EditText/.test(a.class ?? ""), scrollable = a.scrollable === "true";
    if (!text && !clickable && !editable && !scrollable) continue;
    const b = (a.bounds ?? "").match(/\d+/g)?.map(Number) ?? [0, 0, 0, 0];
    out.push({ i: out.length, role: (a.class ?? "").split(".").pop()!, text, id: (a["resource-id"] ?? "").split("/").pop()!, bounds: b, clickable, editable, scrollable });
  }
  return out;
}

const center = (args: any) => {
  if (typeof args.index === "number") {
    const e = last[args.index];
    if (!e) throw new Error(`no element ${args.index} in the latest phone_state`);
    return [Math.round((e.bounds[0]! + e.bounds[2]!) / 2), Math.round((e.bounds[1]! + e.bounds[3]!) / 2)];
  }
  return [args.x, args.y];
};
const KEYS: Record<string, string> = { back: "KEYCODE_BACK", home: "KEYCODE_HOME", recents: "KEYCODE_APP_SWITCH", enter: "KEYCODE_ENTER", notifications: "KEYCODE_NOTIFICATION" };

function act(args: any): { result: unknown; image?: string } {
  switch (args.action) {
    case "state": {
      last = screen();
      const shot = serial && args.screenshot !== false ? Buffer.from(run(["exec-out", "screencap", "-p"])).toString("base64") : undefined;
      return { result: { elements: last.slice(0, args.max_nodes ?? 250).map(({ bounds: _b, ...e }) => e) }, image: shot };
    }
    case "tap": {
      const [x, y] = center(args);
      if (serial) adb(["shell", "input", "tap", String(x), String(y)]);
      return { result: `tap dispatched at ${x},${y}` };
    }
    case "type":
      if (serial) adb(["shell", "input", "text", String(args.text ?? "").replace(/ /g, "%s")]);
      return { result: "typed" };
    case "key":
      if (serial) adb(["shell", "input", "keyevent", KEYS[args.key] ?? "KEYCODE_HOME"]);
      return { result: `${args.key} pressed` };
    case "wait":
      return { result: "waited" };
    default:
      return { result: `${args.action} dispatched` };
  }
}

if (existsSync(socket)) rmSync(socket);
const server = createServer((c) => {
  let buf = "";
  c.on("data", async (d) => {
    buf += d.toString();
    const n = buf.indexOf("\n");
    if (n < 0) return;
    const req = JSON.parse(buf.slice(0, n));
    const s = read();
    let answer: any;
    if (req.op === "status") {
      s.statuses = (s.statuses ?? 0) + 1;
      write(s);
      answer = { ok: true, armed: !!s.armed, since: null };
    } else if (req.op === "call") {
      (s.calls ??= []).push(req.args);
      const hold = s.hold;
      s.hold = false;
      write(s);
      if (!s.armed) answer = { ok: false, error: "phone not armed: turn on Me > This phone > Control in the Hermes app" };
      else if (hold) {
        // Until the owner presses Stop on the phone.
        while (!read().stop) await new Promise((r) => setTimeout(r, 100));
        const t = read();
        t.armed = false;
        t.stop = false;
        write(t);
        answer = { ok: false, error: "phone control disarmed or revoked" };
      } else {
        try {
          answer = { ok: true, ...act(req.args) };
        } catch (e) {
          answer = { ok: false, error: (e as Error).message };
        }
      }
    } else answer = { ok: false, error: "unknown request" };
    if (!c.destroyed) c.end(JSON.stringify(answer) + "\n");
  });
  c.on("error", () => {});
});
server.listen(socket, () => console.log(`phone gateway stand-in on ${socket}${serial ? ` (adb ${serial})` : ""}`));
