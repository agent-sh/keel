// The digests of words a model sent into another harness's session through the drive (src/drive/sent.ts), and the
// read that finds the sends of the stored history: pure, so the read thread loads it (src/server/read-tasks.ts).
import type { Database } from "bun:sqlite";
import { outsideText } from "./text.ts";

// The drive's tools that put a model's words at another session's prompt, and the input that holds them.
export const SENDS: Record<string, string> = { keel__session_message: "text", keel__session_resume: "text", keel__session_answer: "note" };

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

// Whether a recorded prompt is words a model sent: its whole was sent, or each of its lines that holds words was.
export function sentBy(text: string, known: (digest: string) => boolean): boolean {
  const lines = text.split(/\r\n|[\r\n\u0085\u2028\u2029]/).filter((l) => l.trim());
  return known(digest(text)) || (lines.length > 0 && lines.every((l) => known(digest(l))));
}

// The words of one call by a send tool, called by its name or through mcp_call.
function sentWords(b: any): string | undefined {
  if (b?.type !== "tool_use") return undefined;
  const [name, input] = b.name === "mcp_call" ? [b.input?.tool ?? b.input?.name, b.input?.arguments] : [b.name, b.input];
  const key = typeof name === "string" ? SENDS[name] : undefined;
  const words = key && input && typeof input === "object" ? input[key] : undefined;
  return typeof words === "string" ? words : undefined;
}

export type SentAsk = { after: number; span: number };
// The digests of every send the replies with rowid in (after, after + span] hold; `next`: where the read goes on
// from, null past the last event.
export function sentCalls(db: Database, a: SentAsk): { digests: string[]; next: number | null } {
  const needles = Object.keys(SENDS).map((n) => `"${n}"`);
  const rows = db.query<{ data: string }, [number, number, ...string[]]>(
    `SELECT data FROM events WHERE rowid > ? AND rowid <= ? AND kind = 'assistant' AND (${needles.map(() => "instr(data, ?) > 0").join(" OR ")})`,
  ).all(a.after, a.after + a.span, ...needles);
  const digests = new Set<string>();
  for (const r of rows) {
    let blocks: any[] = [];
    try { blocks = (JSON.parse(r.data) as { blocks?: any[] }).blocks ?? []; } catch { continue; }
    for (const b of blocks) { const w = sentWords(b); if (w) for (const d of digestsOf(w)) digests.add(d); }
  }
  const last = db.query<{ n: number | null }, []>("SELECT MAX(rowid) AS n FROM events").get()?.n ?? 0;
  return { digests: [...digests], next: a.after + a.span < last ? a.after + a.span : null };
}
