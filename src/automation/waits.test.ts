// Log waits read on from a durable cursor (a restart, a rotated file, a line
// longer than one read), a monitor matches whole lines, and a cancel says what
// it did. A wake a wait owes survives a daemon that stops at any point between
// reading the match and storing the wake. What a restart does cannot be
// reached from the page.
import { expect, setSystemTime, test } from "bun:test";
import { appendFileSync, mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../core/bus.ts";
import { Store } from "../core/store.ts";
import { dropPending, flush, setDeps } from "./core.ts";
import * as activity from "./activity.ts";
import * as waits from "./waits.ts";

const dir = mkdtempSync(join(tmpdir(), "keel-waits-"));
const sent: string[] = [];
const store = new Store(join(dir, "state"));
const busy = new Set<string>(); // sessions with a turn running
const faults: { afterAppend?: boolean } = {};
const engine = {
  isRunning: (id: string) => busy.has(id),
  send: (id: string, text: string, o: any) => {
    sent.push(text);
    const event = store.append(id, "user", { text, ...o?.meta });
    if (faults.afterAppend) throw new Error("the daemon stopped here");
    return { event };
  },
};
setDeps({ store, bus: new Bus(), errors: { capture() {} }, engine } as any);
waits.migrate();
activity.migrate();
const s = store.createSession({ model: "m", workspace: dir, title: "t" });
const log = (name: string, text = "") => (writeFileSync(join(dir, name), text), join(dir, name));
const wait = (path: string) => waits.create(s.id, waits.normalize({ kind: "log", path, match: "^READY$" }, dir), { timeout_seconds: 60 });
const status = (id: string) => waits.get(id)!.status;
// The wakes of a wait stored in the session's transcript.
const wakes = (id: string) => store.events(s.id).filter((e) => e.kind === "user" && String(e.data.text).includes(`<wait_fired id="${id}"`)).map((e) => String(e.data.text));
// A new daemon: what was only in memory is gone, and it recovers from the store.
const restart = () => { busy.clear(); dropPending(s.id); waits.recover(); flush(s.id); };

test("a line written while the daemon was down still wakes the wait; one written before it never does", async () => {
  const p = log("restart.log", "OLD\nREADY\n");
  const w = wait(p);
  appendFileSync(p, "READY\n"); // written during the restart
  waits.recover(); // what a new daemon does with the saved cursor
  await waits.tick();
  expect(status(w.id)).toBe("fired");
  expect(waits.get(w.id)!.outcome).toContain("READY");
});

test("a replaced file is read from its start, whatever its size", async () => {
  for (const [n, text] of [["small", "READY\n"], ["equal", "READY\nab\n"], ["large", "READY\nabcd\n"]] as const) {
    const p = log(`${n}.log`, "12345678");
    const w = wait(p);
    writeFileSync(`${p}.new`, text);
    renameSync(`${p}.new`, p);
    await waits.tick();
    expect(`${n}:${status(w.id)}`).toBe(`${n}:fired`);
  }
  // An append to the same file does not replay what was there before.
  const p = log("append.log", "READY\n");
  const w = wait(p);
  appendFileSync(p, "other\n");
  await waits.tick();
  expect(status(w.id)).toBe("active");
});

test("a line longer than one read is skipped and the next complete line still matches", async () => {
  const p = log("long.log");
  const w = wait(p);
  appendFileSync(p, `${"x".repeat(4 << 20)}\nREADY\n`);
  // A log is probed once a second: the skip, then the line after it.
  for (let i = 0; i < 3 && status(w.id) === "active"; i++) { await waits.tick(); if (status(w.id) === "active") await Bun.sleep(1001); }
  expect(status(w.id)).toBe("fired");
});

test("a monitor matches the whole line, however it is split", async () => {
  const pad = (n: number) => "x".repeat(n);
  // A marker across the 2,000-character display cut, and one across two writes.
  const cmd = `printf '${pad(1996)}READY\\n'; printf '${pad(10)}REA'; sleep 0.2; printf 'DY\\n'; printf 'nothing here\\n'`;
  const w = waits.create(s.id, waits.normalize({ kind: "monitor", command: cmd, match: "READY", coalesce_ms: 0 }, dir), { timeout_seconds: 30 });
  for (let i = 0; i < 40 && status(w.id) === "active"; i++) { await waits.tick(); await Bun.sleep(100); }
  const events = sent.filter((t) => t.includes(`<monitor_event id="${w.id}"`)).join("\n");
  expect(events.match(/READY/g)?.length).toBe(2);
  expect(events).not.toContain("nothing here");
});

test("cancelling a wait that already fired says it did not stop the wake", async () => {
  const t = waits.create(s.id, waits.normalize({ kind: "timer", seconds: 0.001 }, dir));
  await Bun.sleep(5);
  await waits.tick();
  expect(waits.cancel(t.id)).toBe("fired");
  expect(waits.cancelText(t.id, "fired")).toContain("did not stop");
  const u = waits.create(s.id, waits.normalize({ kind: "timer", seconds: 60 }, dir));
  expect(waits.cancel(u.id)).toBe("cancelled");
  expect(waits.cancel(u.id)).toBe("already_cancelled");
  expect(status(u.id)).toBe("cancelled");
});

test("a process wait ends when its pid comes to name another process", async () => {
  const real = { ...waits.procfs };
  let start = "100", alive = true;
  waits.procfs.signal0 = (pid) => (pid === 4242 ? alive : real.signal0(pid));
  waits.procfs.stat = (pid) => (pid === 4242 ? `4242 (job one) S 1 ${Array.from({ length: 17 }, () => "0").join(" ")} ${start} 0` : real.stat(pid));
  try {
    const w = waits.create(s.id, waits.normalize({ kind: "process", pid: 4242 }, dir), { timeout_seconds: 600 });
    let t = Date.now();
    const later = async () => { setSystemTime(new Date((t += 60_000))); await waits.tick(); };
    await later();
    expect(status(w.id)).toBe("active"); // the same process runs on
    start = "200"; // it ended, and the pid now names a new process
    await later();
    expect(status(w.id)).toBe("fired");
    expect(waits.get(w.id)!.outcome).toContain("another process");
  } finally {
    Object.assign(waits.procfs, real);
    setSystemTime();
  }
});

test("a daemon that stops after reading the matching line still wakes the session, once", async () => {
  const p = log("gap-read.log");
  const w = wait(p);
  appendFileSync(p, "noise\nREADY\n");
  // The line is read and the daemon is gone before the wait is settled.
  const query = store.db.query.bind(store.db);
  (store.db as any).query = (sql: string) => { if (sql.startsWith("UPDATE waits SET status")) throw new Error("the daemon stopped here"); return query(sql); };
  try { await waits.tick(); } finally { (store.db as any).query = query; }
  expect(status(w.id)).toBe("active");
  restart();
  await waits.tick();
  restart(); // and a restart after it fired changes nothing
  expect(status(w.id)).toBe("fired");
  expect(wakes(w.id)).toHaveLength(1);
  expect(wakes(w.id)[0]).toContain("READY");
});

test("a wake settled while the session was busy is sent after a restart, once", async () => {
  const p = log("gap-busy.log");
  const w = wait(p);
  appendFileSync(p, "READY\n");
  busy.add(s.id); // the wake waits in memory for the turn to end
  await waits.tick();
  expect(status(w.id)).toBe("fired");
  expect(wakes(w.id)).toHaveLength(0);
  restart();
  restart();
  expect(wakes(w.id)).toHaveLength(1);
  expect(wakes(w.id)[0]).toContain("READY");
});

test("a wake stored before the daemon stopped is not sent again", async () => {
  const p = log("gap-ack.log");
  const w = wait(p);
  appendFileSync(p, "READY\n");
  faults.afterAppend = true; // stored in the transcript, never acknowledged
  try { await waits.tick(); } finally { faults.afterAppend = false; }
  expect(wakes(w.id)).toHaveLength(1);
  restart();
  restart();
  expect(wakes(w.id)).toHaveLength(1);
  expect(wakes(w.id)[0]).toContain("READY");
});

test("a cancelled wait sends no wake, before or after a restart", async () => {
  const p = log("gap-cancel.log");
  const w = wait(p);
  appendFileSync(p, "READY\n");
  expect(waits.cancel(w.id)).toBe("cancelled");
  await waits.tick();
  restart();
  await waits.tick();
  expect(status(w.id)).toBe("cancelled");
  expect(wakes(w.id)).toHaveLength(0);
});
