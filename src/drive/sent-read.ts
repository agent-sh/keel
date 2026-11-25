// The keys of words a model sent into another harness's session through the drive (src/drive/sent.ts), the check of
// a recorded prompt against them, and the read that finds the sends of the stored history: pure, so the read thread
// loads it (src/server/read-tasks.ts).
//
// One broad rule: a prompt is a model's when it holds, anywhere, a run of words a model sent. A sent text is kept
// by the keys of its runs of up to RUN words: a text of RUN words or fewer (or a line of one) by its own key, a
// longer one by the key of each run of RUN words in it. A prompt is a model's when any run of up to RUN words of
// it, starting at any word, has a kept key. That counts more prompts as the model's than hold a whole sent text (a
// prompt sharing RUN words with a send, or a word with a one-word send), which only loses an owner prompt's mark:
// the safe side.
import type { Database } from "bun:sqlite";
import { outsideText } from "./text.ts";

// The drive's tools that put a model's words at another session's prompt, and the input that holds them
// (keel__session_send: the message tool's name in the drive's first builds). keel__session_model sends its harness's
// `/model <name>` command (src/drive/drive.ts modelCommand), read as those words.
export const SENDS: Record<string, string> = { keel__session_message: "text", keel__session_send: "text", keel__session_resume: "text", keel__session_answer: "note", keel__session_model: "model" };

const RUN = 6;
// The words as a harness records what was pasted at its prompt: spacing, line breaks and the punctuation around a
// word may differ (a harness that takes two sends as one prompt may join them with a period), the words do not. A
// word of punctuation alone is no word.
const EDGE = /^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu;
export const wordsOf = (text: string) => text.split(/[\s\u0085]+/u).map((w) => w.replace(EDGE, "")).filter(Boolean);
const key = (w: string[]) => `w${w.length}:${Bun.hash(w.join(" "))}`;
// The keys a far Keel may be given (noteDigests).
export const farDigest = (d: string) => /^w[1-6]:\d{1,24}$/.test(d);

function runsInto(out: Set<string>, w: string[]) {
  if (w.length <= RUN) { if (w.length) out.add(key(w)); }
  else for (let i = 0; i + RUN <= w.length; i++) out.add(key(w.slice(i, i + RUN)));
}

// `loose`: the send may land beside text already in the session's input box (an unsent draft of the owner's, when
// the box could not be read: src/drive/box.ts), which a harness records as one prompt with the send, a word of the
// draft perhaps glued to the send's first or last word. Its words are then also kept without the first, without the
// last and without both, so a short send is still found in such a prompt.
function keysInto(out: Set<string>, text: string, loose: boolean) {
  const vary = (w: string[]) => (loose ? [w, w.slice(1), w.slice(0, -1), w.slice(1, -1)] : [w]);
  for (const v of vary(wordsOf(text))) runsInto(out, v);
  // A harness may keep a line of a send alone: a short line is a sent text of its own.
  for (const line of text.split("\n")) {
    const w = wordsOf(line);
    if (w.length && w.length < RUN) for (const v of vary(w)) if (v.length) out.add(key(v));
  }
}

// The keys of a send, its words as the drive delivers them (outsideText: the characters a delivery drops are
// dropped here too). Empty when nothing would be sent.
export function digestsOf(text: string, loose = false): string[] {
  let body: string;
  try { body = outsideText(text).text; } catch { return []; }
  const out = new Set<string>();
  keysInto(out, body, loose);
  return [...out];
}

// The keys of every run of up to RUN words of a recorded prompt, starting at each of its words.
export function promptKeys(text: string): string[] {
  const w = wordsOf(text);
  const out = new Set<string>();
  for (let i = 0; i < w.length; i++) for (let k = 1; k <= RUN && i + k <= w.length; k++) out.add(key(w.slice(i, i + k)));
  return [...out];
}

// Whether a recorded prompt holds a run of words a model sent. `any`: whether any of the keys is kept.
export const sentBy = (text: string, any: (keys: string[]) => boolean) => {
  const keys = promptKeys(text);
  return keys.length > 0 && any(keys);
};

// For each prompt, whether a model sent it (a store with no record of sends: every one). The read thread runs it
// for an import (src/integrations/import/service.ts): a long prompt has many keys.
export function sentOf(db: Database, a: { texts: string[] }): boolean[] {
  try {
    const q = db.query<unknown, [string]>("SELECT 1 FROM drive_sends WHERE digest IN (SELECT value FROM json_each(?)) LIMIT 1");
    return a.texts.map((t) => sentBy(t, (keys) => !!q.get(JSON.stringify(keys))));
  } catch {
    return a.texts.map(() => true);
  }
}

// The words of one call by a send tool, called by its name or through mcp_call. keel__session_send is also the
// fleet's tool that messages one of Keel's own sessions (a session id, a title, `<machine>/<id>`): a call of it is the
// drive's only when its `to` is an id of the agent view's, `<harness>:<key>` (a title with a colon counts too, which
// errs on the side of holding).
function sentWords(name: unknown, input: any): string | undefined {
  if (name === "mcp_call") [name, input] = [input?.tool ?? input?.name, input?.arguments];
  if (name === "keel__session_send" && !(typeof input?.to === "string" && input.to.includes(":"))) return undefined;
  if (name === "keel__session_model") return typeof input?.model === "string" ? `/model ${input.model}` : undefined;
  const k = typeof name === "string" ? SENDS[name] : undefined;
  const words = k && input && typeof input === "object" ? input[k] : undefined;
  return typeof words === "string" ? words : undefined;
}

// The string values of a JSON text cut short, each with its path of keys ("#" for an array's place), the last one
// perhaps cut.
function stringsOf(json: string): { path: string[]; value: string; cut: boolean }[] {
  type Frame = { obj: boolean; key?: string; wantKey: boolean };
  const stack: Frame[] = [];
  const out: { path: string[]; value: string; cut: boolean }[] = [];
  for (let i = 0; i < json.length; i++) {
    const c = json[i];
    const top = stack[stack.length - 1];
    if (c === "{") stack.push({ obj: true, wantKey: true });
    else if (c === "[") stack.push({ obj: false, wantKey: false });
    else if (c === "}" || c === "]") stack.pop();
    else if (c === "," && top?.obj) { top.wantKey = true; top.key = undefined; }
    else if (c === '"') {
      let j = i + 1;
      while (j < json.length && json[j] !== '"') j += json[j] === "\\" ? 2 : 1;
      const cut = j >= json.length;
      const raw = json.slice(i + 1, Math.min(j, json.length));
      let value: string | undefined;
      for (let drop = 0; drop < 6 && value === undefined; drop++) { try { value = JSON.parse(`"${raw.slice(0, raw.length - drop)}"`) as string; } catch {} }
      i = j;
      if (value === undefined) continue;
      if (top?.obj && top.wantKey) { top.key = value; top.wantKey = false; }
      else out.push({ path: stack.map((f) => (f.obj ? (f.key ?? "") : "#")), value, cut });
    }
  }
  return out;
}

// The words of a send whose input the page's record kept cut (src/server/routes/codemode.ts clipInput: the input's
// JSON up to a length, then a note of how much more): the value of the send's own input field, at the top of the
// input (inside `arguments` for mcp_call), never a field of the same name deeper in. A value the cut fell in keeps
// its words before the last, which may be cut.
function clippedWords(tool: string, clipped: string): string[] {
  const json = clipped.replace(/ \[\.\.\. \d+ more characters\]$/, "");
  const all = stringsOf(json);
  const at = (path: string[]) => all.filter((s) => s.path.length === path.length && s.path.every((p, i) => p === path[i]));
  let base: string[] = [];
  let fields = [...new Set(Object.values(SENDS))];
  if (tool === "mcp_call") {
    base = ["arguments"];
    const named = [...at(["tool"]), ...at(["name"])].map((s) => s.value).find((n) => SENDS[n]);
    if (named) fields = [SENDS[named]!];
    else if ([...at(["tool"]), ...at(["name"])].some((s) => !s.cut)) return []; // another tool
  } else if (SENDS[tool]) fields = [SENDS[tool]!];
  else return [];
  const out: string[] = [];
  for (const f of fields) {
    for (const s of at([...base, f])) out.push(s.cut ? s.value.replace(/\S*$/, "") : s.value);
  }
  return out;
}

export type SentAsk = { after: number; span: number; table?: "events" | "code_calls" };
// The keys of every send the rows with rowid in (after, after + span] hold: the replies of the events, or the calls
// programs made inside run_code (the code_calls the page keeps, read as src/safety/marks.ts reads them). `next`:
// where the read goes on from, null past the last row.
export function sentCalls(db: Database, a: SentAsk): { digests: string[]; next: number | null } {
  const table = a.table ?? "events";
  const needles = Object.keys(SENDS).map((n) => `"${n}"`);
  const digests = new Set<string>();
  // What an input box held when a past send went is not known: its keys are loose.
  const add = (words: string | undefined) => { if (words) for (const d of digestsOf(words, true)) digests.add(d); };
  let last = 0;
  if (table === "events") {
    const rows = db.query<{ data: string }, [number, number, ...string[]]>(
      `SELECT data FROM events WHERE rowid > ? AND rowid <= ? AND kind = 'assistant' AND (${needles.map(() => "instr(data, ?) > 0").join(" OR ")})`,
    ).all(a.after, a.after + a.span, ...needles);
    for (const r of rows) {
      let blocks: any[] = [];
      try { blocks = (JSON.parse(r.data) as { blocks?: any[] }).blocks ?? []; } catch { continue; }
      for (const b of blocks) if (b?.type === "tool_use") add(sentWords(b.name, b.input));
    }
    last = db.query<{ n: number | null }, []>("SELECT MAX(rowid) AS n FROM events").get()?.n ?? 0;
  } else {
    try {
      const rows = db.query<{ data: string }, [number, number, ...string[]]>(
        `SELECT data FROM code_calls WHERE rowid > ? AND rowid <= ? AND (${Object.keys(SENDS).map(() => "instr(data, ?) > 0").join(" OR ")})`,
      ).all(a.after, a.after + a.span, ...Object.keys(SENDS));
      for (const r of rows) {
        let c: any;
        try { c = JSON.parse(r.data); } catch { continue; }
        if (typeof c?.input?.clipped === "string") { for (const w of clippedWords(String(c.tool), c.input.clipped)) add(w); continue; }
        add(sentWords(c?.tool, c?.input));
      }
      last = db.query<{ n: number | null }, []>("SELECT MAX(rowid) AS n FROM code_calls").get()?.n ?? 0;
    } catch {
      // A store that has run no program has no such table.
    }
  }
  return { digests: [...digests], next: a.after + a.span < last ? a.after + a.span : null };
}
