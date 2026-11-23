// A search index made again is filled on a thread of its own
// (search-fill-worker.ts), not on the loop: on a store of a few gigabytes the
// fill reads every event and indexes its words, tens of seconds of work.
// Meanwhile a search reads the old index, kept current, or, with none to
// read, what is filled so far, newest first. Where no thread can run (unit
// tests, a thread that fails to start), the fill runs here in the same steps.
import type { Store } from "../../core/store.ts";
import { storePath } from "../../core/store-files.ts";
import type { Database } from "bun:sqlite";
import { dropStep, fillOne, fillStep, nextRows, passBelow, searchMeta } from "./search-index.ts";

declare const __KEEL_SEARCHFILL_JS__: string | undefined;

let program: string | undefined;
function programUrl(): string {
  if (program) return program;
  return (program = typeof __KEEL_SEARCHFILL_JS__ === "string"
    ? URL.createObjectURL(new Blob([__KEEL_SEARCHFILL_JS__], { type: "application/javascript" }))
    : new URL("./search-fill-worker.ts", import.meta.url).href);
}

// `step_most_ms`: the longest step (the write lock is held that long), `steps` how many, `slow_steps` how many held it
// over SLOW_MS; `drop_ms`: removing the old index, in steps.
export type FillState = { running: boolean; filled: number; done?: boolean; ms?: number; step_most_ms?: number; steps?: number; slow_steps?: number; drop_ms?: number; error?: string };
const SLOW_MS = 50;
// What the last fill of this process did (the resources page and the tests read it).
export const fill: FillState = { running: false, filled: 0 };

type Opts = {
  oldGone: () => void;
  // Told of what could not be filled or a fill that failed (the daemon's error tracker).
  failed?: (e: Error, context: unknown) => void;
  // false: the fill runs on the loop at once (unit tests); a test names a thread to see it run there.
  thread?: boolean;
  // What the fill waits for before it starts: the start's own passes (search.ts).
  after?: Promise<unknown>;
  // Told when the fill is over.
  done?: () => void;
};

export function startFill(store: Pick<Store, "db" | "stateDir">, o: Opts) {
  if (fill.running) return;
  Object.assign(fill, { running: true, filled: 0, done: false, ms: undefined, step_most_ms: 0, steps: 0, slow_steps: 0, drop_ms: undefined, error: undefined });
  const t = performance.now();
  const end = (error?: string) => {
    Object.assign(fill, { running: false, done: !error, ms: Math.round(performance.now() - t), ...(error ? { error } : {}) });
    if (!error) o.oldGone();
    o.done?.();
  };
  const failed = (e: unknown) => { o.failed?.(e as Error, { what: "the search index's fill" }); end(String(e)); };
  if (!(o.thread ?? process.env.NODE_ENV !== "test")) {
    try { fillHere(store, o); end(); } catch (e) { failed(e); }
    return;
  }
  const begin = () => {
    let w: Worker;
    try {
      w = new Worker(programUrl());
    } catch (e) {
      // Where no thread starts, the same steps run on the loop, one a moment apart.
      o.failed?.(e as Error, { what: "the search index's fill thread did not start; it fills on the loop" });
      return void fillPaced(store, o).then(() => end(), failed);
    }
    (w as Worker & { unref?: () => void }).unref?.(); // the thread never holds the process open
    w.onmessage = (ev: MessageEvent) => {
      const m = ev.data as { progress?: number; dropping?: number; ms?: number; failed?: number; message?: string; done?: number; drop_ms?: number; error?: { message: string; stack?: string } };
      if (m.progress !== undefined) fill.filled = m.progress;
      if (m.ms !== undefined) {
        fill.step_most_ms = Math.max(fill.step_most_ms ?? 0, Math.round(m.ms));
        fill.steps = (fill.steps ?? 0) + 1;
        if (m.ms > SLOW_MS) fill.slow_steps = (fill.slow_steps ?? 0) + 1;
      }
      if (m.drop_ms !== undefined) fill.drop_ms = m.drop_ms;
      if (m.failed !== undefined) o.failed?.(new Error(`an event could not be indexed for search: ${m.message}`), { what: "the search index's fill", rowid: m.failed });
      if (m.done !== undefined) { fill.filled = m.done; end(); w.terminate(); }
      if (m.error) { o.failed?.(Object.assign(new Error(m.error.message), { stack: m.error.stack }), { what: "the search index's fill" }); end(m.error.message); w.terminate(); }
    };
    w.onerror = (ev: ErrorEvent) => { o.failed?.(new Error(ev.message), { what: "the search index's fill thread" }); end(ev.message); };
    w.postMessage({ open: storePath(store.stateDir) });
  };
  if (o.after) o.after.then(begin, begin);
  else begin();
}

// One step of the fill, or of removing the old index once the fill is done, on the loop's connection.
function stepHere(db: Database, o: Opts): boolean {
  if (searchMeta(db)?.fill_below != null) {
    try {
      const r = fillStep(db, 256 * 1024);
      fill.filled += r.events;
      if (r.left) return true;
    } catch (e) {
      const rows = nextRows(db, 50);
      for (const rowid of rows) if (!fillOne(db, rowid)) o.failed?.(new Error(`an event could not be indexed for search: ${(e as Error)?.message ?? e}`), { what: "the search index's fill", rowid });
      if (rows.length) passBelow(db, rows.at(-1)!);
      fill.filled += rows.length;
      return true;
    }
  }
  return dropStep(db, 500).left;
}
// At once (unit tests).
function fillHere(store: Pick<Store, "db">, o: Opts) {
  while (stepHere(store.db, o));
}
// One step, then the loop's other work.
async function fillPaced(store: Pick<Store, "db">, o: Opts) {
  for (;;) {
    const t = performance.now();
    if (!stepHere(store.db, o)) return;
    await Bun.sleep(Math.max(10, 4 * (performance.now() - t)));
  }
}
