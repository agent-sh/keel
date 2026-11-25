// The digests of words a model sent into another harness's session through the drive (src/drive/sent.ts), and the
// read that finds the sends of the stored history: pure, so the read thread loads it (src/server/read-tasks.ts).
import type { Database } from "bun:sqlite";
import { outsideText } from "./text.ts";

// The drive's tools that put a model's words at another session's prompt, and the input that holds them
// (keel__session_send: the message tool's name in the drive's first builds).
export const SENDS: Record<string, string> = { keel__session_message: "text", keel__session_send: "text", keel__session_resume: "text", keel__session_answer: "note" };

// The words as a harness records what was pasted at its prompt: spacing may differ, the words do not.
const digest = (text: string) => String(Bun.hash(text.replace(/\s+/g, " ").trim()));

// The words as the drive delivers them (outsideText: the characters a delivery drops are dropped here too), then
// the digest of the whole and of each line that holds words: a harness can take two sends as one prompt, or keep a
// part of one, and a prompt each of whose lines a model sent is the model's. Empty when nothing would be sent.
export function digestsOf(text: string): string[] {
  let body: string;
  try { body = outsideText(text).text; } catch { return []; }
  const lines = body.split("\n").filter((l) => l.trim());
  return [...new Set([digest(body), ...lines.map(digest)])];
}

// The lines of a send the history kept cut (clippedWords): under a kind of their own, since what followed them is
// not known.
const CUT = "cut:";

// Whether a recorded prompt is words a model sent: its whole was sent, or each of its lines that holds words was, or
// one of its lines is a line of a send the history kept cut (the rest of that send may be any of its other lines).
export function sentBy(text: string, known: (digest: string) => boolean): boolean {
  const lines = text.split(/\r\n|[\r\n\u0085\u2028\u2029]/).filter((l) => l.trim());
  return known(digest(text)) || (lines.length > 0 && lines.every((l) => known(digest(l)))) || lines.some((l) => known(CUT + digest(l)));
}

// The words of one call by a send tool, called by its name or through mcp_call. keel__session_send is also the
// fleet's tool that messages one of Keel's own sessions (a session id, a title, `<machine>/<id>`): a call of it is the
// drive's only when its `to` is an id of the agent view's, `<harness>:<key>` (a title with a colon counts too, which
// errs on the side of holding).
function sentWords(name: unknown, input: any): string | undefined {
  if (name === "mcp_call") [name, input] = [input?.tool ?? input?.name, input?.arguments];
  if (name === "keel__session_send" && !(typeof input?.to === "string" && input.to.includes(":"))) return undefined;
  const key = typeof name === "string" ? SENDS[name] : undefined;
  const words = key && input && typeof input === "object" ? input[key] : undefined;
  return typeof words === "string" ? words : undefined;
}

// The words of a send whose input the page's record kept cut (src/server/routes/codemode.ts clipInput: the input's
// JSON up to a length): whole when the cut fell after them, else `cut`, each whole line before the cut (the lines
// past it are not known, so a prompt that holds any of these is counted a model's: sentBy).
function clippedWords(clipped: string): { whole?: string; cut: string[] } {
  for (const key of new Set(Object.values(SENDS))) {
    const at = clipped.indexOf(`"${key}":"`);
    if (at < 0) continue;
    const raw = clipped.slice(at + key.length + 4);
    let i = 0;
    while (i < raw.length && raw[i] !== '"') i += raw[i] === "\\" ? 2 : 1;
    const closed = i < raw.length;
    const body = raw.slice(0, Math.min(i, raw.length));
    for (let cut = 0; cut < 6; cut++) {
      try {
        const text = JSON.parse(`"${body.slice(0, body.length - cut)}"`) as string;
        return closed ? { whole: text, cut: [] } : { cut: text.split("\n").slice(0, -1) };
      } catch {}
    }
    return { cut: [] };
  }
  return { cut: [] };
}

export type SentAsk = { after: number; span: number; table?: "events" | "code_calls" };
// The digests of every send the rows with rowid in (after, after + span] hold: the replies of the events, or the
// calls programs made inside run_code (the code_calls the page keeps, read as src/safety/marks.ts reads them).
// `next`: where the read goes on from, null past the last row.
export function sentCalls(db: Database, a: SentAsk): { digests: string[]; next: number | null } {
  const table = a.table ?? "events";
  const needles = Object.keys(SENDS).map((n) => `"${n}"`);
  const digests = new Set<string>();
  const add = (words: string | undefined) => { if (words) for (const d of digestsOf(words)) digests.add(d); };
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
        if (typeof c?.input?.clipped === "string") {
          const w = clippedWords(c.input.clipped);
          add(w.whole);
          for (const l of w.cut) if (l.trim()) digests.add(CUT + digest(l));
          continue;
        }
        add(sentWords(c?.tool, c?.input));
      }
      last = db.query<{ n: number | null }, []>("SELECT MAX(rowid) AS n FROM code_calls").get()?.n ?? 0;
    } catch {
      // A store that has run no program has no such table.
    }
  }
  return { digests: [...digests], next: a.after + a.span < last ? a.after + a.span : null };
}
