// A daemon whose ids and clock are the same from one run to the next: the scripted daemon a run of
// before and after pictures starts (src/pictures/run.ts sets KEEL_PICTURES_FIXED to the run's own
// instant, scripts/smoke.sh passes it on). Two runs of the same commit then draw the same page: no
// random id, and no time that is not the run's own, is in a picture. Only with the scripted provider:
// a daemon that talks to a real model never runs on a made-up clock.
//
// The clock starts at the given instant when the state folder was first used and runs at the real
// pace from there (a deadline still comes, a restart does not go back in time). Ids are UUIDv7 in
// shape: the time part counts up from the instant, the rest comes from a generator seeded by the
// instant, the start's number and the place in the code that asks, so a restart makes no id an earlier
// start made, and a step makes the same id however many ids other work made before it. Math.random is
// seeded too. Secrets (node:crypto's randomBytes and the like) are left as they are.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const FIXED_ENV = "KEEL_PICTURES_FIXED";

// A small seeded generator (mulberry32): enough for ids and jitter, never for a secret.
export function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hex = (n: number, width: number) => Math.floor(n).toString(16).padStart(width, "0").slice(-width);

// The ids of one start: the time part `at` plus a count over every id (so ids keep the order they were made in),
// the rest from a generator of the place that asks (`randOf`): an id one place makes does not move with how
// many some other place made before it (a timer's, a poll's), so the same step makes the same id each run.
export function idMaker(at: number, randOf: () => () => number): { v7: () => string; v4: () => string } {
  let n = 0;
  const tail = (rand: () => number) => {
    const r = () => hex(rand() * 0x10000, 4);
    const v = hex((Math.floor(rand() * 0x10000) & 0x3fff) | 0x8000, 4);
    return `${v}-${r()}${r()}${r()}`;
  };
  return {
    v7: () => {
      const rand = randOf();
      const ms = hex(at + n++, 12);
      return `${ms.slice(0, 8)}-${ms.slice(8)}-7${hex(rand() * 0x1000, 3)}-${tail(rand)}`;
    },
    v4: () => { const rand = randOf(); return `${hex(rand() * 0x10000, 4)}${hex(rand() * 0x10000, 4)}-${hex(rand() * 0x10000, 4)}-4${hex(rand() * 0x1000, 3)}-${tail(rand)}`; },
  };
}

// The place that asks for an id: the first frame of the stack outside this file, by its function and file name
// (no line: a branch that moves lines in a file is the same place).
export function placeOf(stack: string | undefined): string {
  for (const line of (stack ?? "").split("\n").slice(1)) {
    if (line.includes("fixed-world")) continue;
    const f = line.trim().replace(/^at (async )?/, "");
    const paren = f.match(/^(.*?) \((.*)\)$/);
    const [name, loc] = paren ? [paren[1]!, paren[2]!] : ["", f];
    if (loc) return `${name}@${loc.replace(/(:\d+){1,2}$/, "").split("/").pop()}`;
  }
  return "";
}
const hash = (t: string) => { let h = 2166136261; for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 16777619); return h >>> 0; };

// A Date whose now is `now()`; every other use of it is the real one's.
export function fixedDate(now: () => number): DateConstructor {
  const Real = Date;
  function Fixed(this: unknown, ...a: unknown[]) {
    if (!new.target) return new Real(now()).toString();
    return Reflect.construct(Real, a.length ? a : [now()], new.target);
  }
  Fixed.prototype = Real.prototype;
  Object.setPrototypeOf(Fixed, Real);
  (Fixed as unknown as { now: () => number }).now = now;
  return Fixed as unknown as DateConstructor;
}

type Kept = { first_real: number; starts: number };

// Puts the fixed world in place for this process (once: a hot reload keeps it).
export function fixWorld(at: number, stateDir: string): void {
  const g = globalThis as { __keelFixedWorld?: number };
  if (g.__keelFixedWorld !== undefined || !Number.isFinite(at) || at <= 0) return;
  const file = join(stateDir, "fixed-world.json");
  let kept: Kept;
  try { kept = JSON.parse(readFileSync(file, "utf8")) as Kept; kept.starts++; } catch { kept = { first_real: Date.now(), starts: 0 }; }
  try { mkdirSync(stateDir, { recursive: true }); writeFileSync(file, JSON.stringify(kept)); } catch {}
  const realNow = Date.now.bind(Date);
  const now = () => at + (realNow() - kept.first_real);
  const seed = (at % 4294967296) ^ Math.imul(kept.starts + 1, 0x9e3779b1);
  const places = new Map<string, () => number>();
  const randOf = () => {
    const k = placeOf(new Error().stack);
    let r = places.get(k);
    if (!r) places.set(k, (r = seeded(seed ^ hash(k))));
    return r;
  };
  const ids = idMaker(at + kept.starts * 10_000_000, randOf);
  globalThis.Date = fixedDate(now);
  Math.random = seeded((at >>> 3) ^ (kept.starts + 7));
  (Bun as unknown as { randomUUIDv7: () => string }).randomUUIDv7 = ids.v7;
  (crypto as unknown as { randomUUID: () => string }).randomUUID = ids.v4 as () => `${string}-${string}-${string}-${string}-${string}`;
  g.__keelFixedWorld = at;
}
