// Who asked for a read that holds the loop: a short label of the code path,
// for the count of such reads (Store.coldReads) and for the stall row that
// names the statement (src/admin/stall-watch.ts reads the cell below, as it
// reads the statement's).
//
// The label is the path's own name when it gave one (`asAsker`: a route by
// its pattern, a pass of the daemon by what it is), followed by the names of
// the functions on the call stack between the read and that path. Names
// only: a stack frame carries no value. A built binary's names are short
// (its build renames what it can), so the given name is what tells there.
import { AsyncLocalStorage } from "node:async_hooks";

const scope = new AsyncLocalStorage<string>();
// `f` runs as `name` for the reads it makes, across its awaits.
// (Inside another: both names, the outer first.)
export const asAsker = <T>(name: string, f: () => T): T => {
  const outer = scope.getStore();
  return scope.run(outer && !outer.endsWith(name) ? `${outer.split(" > ").at(-1)} > ${name}` : name, f);
};

const LABEL_MAX = 120;
const LABELS_MAX = 500;
const OTHER = 1;
// [0]: the label of who asked for the read that runs, 0 when none does.
export const askerCell = new Int32Array(new SharedArrayBuffer(4));
const texts: string[] = ["", "another path"];
const ids = new Map<string, number>();
const listeners = new Set<(id: number, text: string) => void>();
// Every label made so far, and each new one as it is made (the stall watcher's thread keeps them by id).
export function askerLabels(each: (id: number, text: string) => void): () => void {
  texts.forEach((t, id) => { if (id) each(id, t); });
  listeners.add(each);
  return () => void listeners.delete(each);
}
function idOf(label: string): number {
  let id = ids.get(label);
  if (id !== undefined) return id;
  if (texts.length >= LABELS_MAX) return OTHER;
  id = texts.push(label) - 1;
  ids.set(label, id);
  for (const l of listeners) l(id, label);
  return id;
}

// The store's own frames are not who asked; the engine's pass-through of the same name is not either.
const OWN = /[\\/]core[\\/](?:store|asker)\.ts/;
const OWN_NAMES = new Set(["held", "asker", "asking", "processTicksAndRejections", "inTransactionOf"]);
const FRAME = /^\s*at (?:async )?(?:new )?([\w$.<>]+)?(?: \[as [\w$]+\])? ?\(?(.*?)(?::\d+){0,2}\)?$/;
// The label of the code path that is asking now.
export function asker(): string {
  const named = scope.getStore();
  const names: string[] = [];
  const lines = (new Error().stack ?? "").split("\n").slice(1);
  for (const line of lines) {
    const m = FRAME.exec(line);
    if (!m || OWN.test(m[2] ?? "")) continue;
    const fn = (m[1] ?? "").replace(/^Object\./, "").replace(/^<anonymous>$/, "");
    const file = /([\w.-]+)\.[cm]?[jt]sx?$/.exec(m[2] ?? "")?.[1];
    // (A frame of the runtime, or one with no name and no file of ours, says nothing.)
    if (!fn && !file) continue;
    if (/^(?:node|bun|native):|^internal/.test(m[2] ?? "")) continue;
    // (A built binary renames what it can: a name of a letter or two says nothing.)
    if (fn && fn.length <= 2 && !file) continue;
    // (The read's own frames, where the file does not tell: a built binary is one file.)
    if (OWN_NAMES.has(fn.split(".").at(-1)!)) continue;
    const name = fn && file ? `${fn} (${file})` : fn || `(${file})`;
    if (names.at(-1) !== name) names.push(name);
    if (names.length >= 4) break;
  }
  const label = [named, names.join(" < ")].filter(Boolean).join(": ").replace(/[^\w$.<>() :\/'-]/g, "?").slice(0, LABEL_MAX);
  return label || "a path with no name";
}
// `f` runs with the stall watcher told who asked.
export function asking<T>(who: string, f: () => T): T {
  const was = askerCell[0]!;
  askerCell[0] = idOf(who);
  try { return f(); } finally { askerCell[0] = was; }
}
