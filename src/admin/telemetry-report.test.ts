// The telemetry report reads the ledger by aggregates in SQL: its answer is what it was when it was computed
// from every row (the golden file was made by that code on these rows), and the rows it reads do not grow
// with the ledger.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../core/bus.ts";
import { Store } from "../core/store.ts";
import { allHooks } from "../engine/hooks.ts";
import { Telemetry } from "./telemetry.ts";
import { causeOf } from "./tool-cause.ts";
import { reportOf } from "./telemetry-report.ts";

const GOLDEN = join(import.meta.dir, "telemetry-report.golden.json");
const root = mkdtempSync(join(tmpdir(), "keel-report-"));
// A Telemetry registers turn hooks, which are process-wide.
const hooksAtStart = allHooks().length;
afterAll(() => { allHooks().length = hooksAtStart; rmSync(root, { recursive: true, force: true }); });

const T0 = 1_760_000_000_000;
const DAY = 86_400_000;
const CAUSES = ["expired", "warm_missed", "model_switch", "compaction", "branch_switch", "prefix_changed", "provider_miss"];
const CLASSES = ["rate_limit", "overloaded", "timeout", "declined"];
const MESSAGES = ["File does not exist: /a", "exit 1", "denied", "timed out", "Connection reset"];

// The same rows every run: a small generator in place of a random one.
function fill(store: Store, sessions: string[], calls: number) {
  let x = 12345;
  const next = (n: number) => ((x = (x * 1103515245 + 12345) % 2147483648) >> 4) % n;
  const call = store.db.query("INSERT INTO telemetry_calls (session_id, ts, model, latency_ms, ttft_ms, input, output, cache_read, cache_write, cost, unpriced, outcome, error, cache_break, break_detail, purpose, error_class, attempt, step_ms, text_ms, turn_event) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const tool = store.db.query("INSERT INTO telemetry_tools (session_id, ts, tool, ms, is_error, call_id, error, error_class, model, cause) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  store.db.transaction(() => {
    for (let i = 0; i < calls; i++) {
      const ts = T0 + i * Math.floor((3 * DAY) / calls) + next(1000);
      const failed = next(25) === 0;
      const outcome = failed ? "error" : next(40) === 0 ? "interrupted" : "ok";
      const model = ["p:big", "p:small", "q:other"][next(3)]!;
      const sid = sessions[next(sessions.length)]!;
      const cls = failed || next(60) === 0 ? CLASSES[next(CLASSES.length)]! : null;
      const brk = next(12) === 0 ? CAUSES[next(CAUSES.length)]! : null;
      const lat = next(9) === 0 ? null : 300 + next(9000);
      call.run(sid, ts, model, lat, lat === null || next(7) === 0 ? null : Math.floor(lat / 3), next(5000), next(900), next(40000), next(600),
        next(8) === 0 ? null : (next(1000) + 1) / 7000, next(30) === 0 ? 1 : 0, outcome, failed ? ["overloaded", "boom", ""][next(3)]! : null,
        brk, brk && next(2) ? ["tools", "system"][next(2)]! : null, next(5) === 0 ? "summary" : next(9) === 0 ? "reader" : null, cls,
        next(6) === 0 ? 2 : next(2) ? 1 : null, next(4) === 0 ? null : 500 + next(12000), next(4) === 0 ? null : 100 + next(3000), `turn-${next(80)}`);
      if (i % 2 === 0) {
        const bad = next(14) === 0;
        const msg = MESSAGES[next(MESSAGES.length)]!;
        tool.run(sid, ts + 5, ["Bash", "Read", "Edit", "Grep", "Write"][next(5)]!, next(6) === 0 ? null : 5 + next(2500), bad ? 1 : 0, `c${i}`, bad ? msg : null, bad ? msg : null, model, bad ? causeOf(msg) : null);
      }
    }
  })();
}

// What the ledger answers is the same after the numbers are rounded past what a sum's order can change.
const plain = (v: unknown) => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "number" && !Number.isInteger(x) ? Number(x.toPrecision(9)) : x)));

function setup(calls: number) {
  const store = new Store(mkdtempSync(join(root, "s-")));
  new Telemetry(store, new Bus());
  const sessions = ["alpha", "beta", "gamma"].map((title) => store.createSession({ model: "p:big", workspace: "/", title }).id);
  fill(store, sessions, calls);
  return { store, sessions };
}

const NONE = { daily_usd: null, monthly_usd: null };
const asks = (sessions: string[]) => ({
  all: { since: T0 - 1000, until: T0 + 3 * DAY + 5000 },
  hourly: { since: T0, until: T0 + DAY, bucket: 3_600_000 },
  model: { since: T0, until: T0 + 3 * DAY, model: "p:small" },
  session: { since: T0, until: T0 + 3 * DAY, session: sessions[1] },
  empty: { since: T0 + 10 * DAY, until: T0 + 11 * DAY },
});

test("the report is what it was when every row was read", () => {
  const { store, sessions } = setup(2400);
  const got: Record<string, unknown> = {};
  for (const [name, q] of Object.entries(asks(sessions))) {
    const { spend: _now, ...r } = reportOf(store.db, q, NONE) as any;
    got[name] = plain(r);
  }
  // Session ids are made per run: the golden holds their place.
  const text = JSON.stringify(got).replaceAll(sessions[0]!, "S0").replaceAll(sessions[1]!, "S1").replaceAll(sessions[2]!, "S2");
  if (process.env.WRITE_GOLDEN || !existsSync(GOLDEN)) writeFileSync(GOLDEN, "{\n" + Object.entries(JSON.parse(text)).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(",\n") + "\n}\n");
  expect(JSON.parse(text)).toEqual(JSON.parse(readFileSync(GOLDEN, "utf8")));
});

// A counting wrapper over the database: the rows each statement hands back.
function counted(store: Store) {
  const n = { rows: 0 };
  const db = new Proxy(store.db, {
    get(target, key) {
      if (key !== "query") { const v = Reflect.get(target, key); return typeof v === "function" ? v.bind(target) : v; }
      return (sql: string) => {
        const st = target.query(sql);
        return new Proxy(st, {
          get(s, k) {
            const v = Reflect.get(s, k);
            if (k === "all") return (...a: unknown[]) => { const r = (v as Function).apply(s, a) as unknown[]; n.rows += r.length; return r; };
            if (k === "get") return (...a: unknown[]) => { const r = (v as Function).apply(s, a); if (r) n.rows++; return r; };
            if (k === "iterate") return (...a: unknown[]) => { const it = (v as Function).apply(s, a) as Iterable<unknown>; return (function* () { for (const r of it) { n.rows++; yield r; } })(); };
            return typeof v === "function" ? (v as Function).bind(s) : v;
          },
        });
      };
    },
  }) as unknown as Store["db"];
  return { db, n };
}

test("the rows the report reads stay in the hundreds while the ledger grows", () => {
  const read: number[] = [];
  for (const calls of [1200, 6000]) {
    const { store } = setup(calls);
    const c = counted(store);
    const r = reportOf(c.db, { since: T0 - 1000, until: T0 + 3 * DAY + 5000 }, NONE) as any;
    expect(r.total.calls).toBe(calls);
    read.push(c.n.rows);
  }
  expect(read[1]!).toBeLessThan(600);
  expect(read[1]! - read[0]!).toBeLessThan(100);
});
