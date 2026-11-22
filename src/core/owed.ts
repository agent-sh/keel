// The file of owed writes (owed-writes.jsonl in the state folder): what a
// daemon whose store took no writes still owes it, kept so that a restart
// or a kill does not lose the owner's stop or answer (Store.orLater).
//
// The next start makes what the file holds before it reads anything else,
// so the file is an instruction to the daemon and is treated as one:
// - A line carries a mark only the daemon can make: an HMAC of its text
//   under a key that lives in the database itself (the table store_keys),
//   which the file tools never open and a sandboxed command cannot write.
//   A line without a valid mark is not applied, and that is said. Where the
//   file lies proves nothing.
// - A line names what it is from a short fixed list and holds no SQL. What
//   a daemon can owe is the owner's stop (the queue's hold, no steer left),
//   a card's answer, a turn's own events (its start when it was stopped
//   before one, a call's result, its end, the error that ended it), and the
//   placeholder a result's new secret is stored under. Nothing that widens
//   what a session may do (a mode, a sandbox, a standing rule, a prompt) is
//   ever owed, so no line can ask for it.
// - Each line is checked before it is made: an event's kind, id and time,
//   its session existing, a card's answer naming a card that is pending.
// - The file is the daemon's alone: the file tools refuse it by name and as
//   the same file under another (store-files.ts), it is opened without
//   following a link, and it is held to a few megabytes.
//
// A line is `<mark> <json>`. The JSON has the file's version (`v`): the
// statements are kept by version, since a file is applied before the
// modules' migrations, against the tables as the build that wrote it left
// them. A build that changes a statement adds a version and keeps the old.
import { createHmac, timingSafeEqual } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import type { EventKind } from "./types.ts";

export const OWED_FILE = "owed-writes.jsonl";
export const OWED_V = 1;
// What the file may hold. In honest use it reached some tens of kilobytes; a record that would take it past this is not filed, and that is said.
export const OWED_FILE_MAX = 4 * 1024 * 1024;

const SQL_V1 = {
  // A stop holds the session's queue (Engine.hold).
  hold: "INSERT INTO queue_holds (session_id, by) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET by = excluded.by",
  // After a stop no queued prompt is a steer any more.
  unsteer: "UPDATE queue SET steer = 0 WHERE session_id = ? AND steer = 1",
  // A card as it stands after its answer (Gate.save): id, session, state, record.
  approval: "UPDATE approvals SET state = ?3, data = ?4 WHERE id = ?1 AND session_id = ?2",
  // The placeholder a secret found in a result is stored under: its id and kind, never its value.
  placeholder: "INSERT INTO secret_placeholders (id, kind, name, created) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = COALESCE(excluded.name, name)",
} as const;
export type OwedSql = keyof typeof SQL_V1;
const SQL: Record<number, Record<string, string>> = { 1: SQL_V1 };
export const owedSql = (name: string, v = OWED_V): string | undefined => (Object.hasOwn(SQL, v) && Object.hasOwn(SQL[v]!, name) ? SQL[v]![name] : undefined);
// The events a turn can owe.
const KINDS: ReadonlySet<string> = new Set<EventKind>(["turn_start", "turn_end", "tool_result", "error"]);
const ANSWERED: ReadonlySet<string> = new Set(["allowed", "denied", "cancelled"]);

export type OwedRecord =
  | { op: "event"; id: string; session: string; kind: EventKind; data: unknown; at: number }
  | { op: "sql"; name: OwedSql; params: (string | number | null)[] };
export type OwedNote = { op: "note"; text: string; at: number };
// `life`: the daemon that wrote it (every line of a file is of one). `what`: the write in a few words, for a sentence about it.
export type OwedLine = (OwedRecord | OwedNote) & { v: number; life: string; what?: string };

const mark = (key: Uint8Array, json: string) => createHmac("sha256", key).update(json).digest("hex");
// The key a file's lines are marked with: the store's key and the file's generation, a number the
// store keeps beside the key and raises each time a file of owed writes is done with (made at a
// start, or made by the daemon that wrote it). A line of an earlier file, put back, is marked with
// a key that is no longer this one: it is not made a second time.
export const owedLineKey = (key: Uint8Array, generation: number): Uint8Array => createHmac("sha256", key).update(`owed generation ${generation}`).digest();
export const encodeOwed = (key: Uint8Array, line: OwedLine): string => {
  const json = JSON.stringify(line);
  return `${mark(key, json)} ${json}\n`;
};

// What the store knows that a line is checked against.
export type OwedFacts = { session: (id: string) => boolean; card: (id: string) => { state: string; session_id: string; data: string } | undefined };
const str = (v: unknown): v is string => typeof v === "string";
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Why this line is not something a daemon owes; "made" when it is already as the line says; undefined: make it.
export function owedRefusal(r: OwedLine, facts: OwedFacts): string | "made" | undefined {
  if (r.op === "event") {
    if (!str(r.id) || !ID.test(r.id)) return "its id is not an event's";
    if (!str(r.kind) || !KINDS.has(r.kind)) return `an event of the kind ${String(r.kind).slice(0, 40)} is never owed`;
    if (!num(r.at)) return "its time is not a number";
    if (r.data === null || typeof r.data !== "object") return "it has no body";
    if (!str(r.session) || !facts.session(r.session)) return "its session is gone";
    return undefined;
  }
  if (r.op !== "sql" || !str(r.name) || !owedSql(r.name, r.v) || !Array.isArray(r.params)) return "it is not a write this build knows";
  const p = r.params as unknown[];
  const session = (v: unknown) => (str(v) && facts.session(v) ? undefined : "its session is gone");
  if (r.name === "hold") return p.length === 2 && (p[1] === null || str(p[1])) ? session(p[0]) : "it is not a hold";
  if (r.name === "unsteer") return p.length === 1 ? session(p[0]) : "it is not a queue's change";
  if (r.name === "placeholder") return p.length === 4 && str(p[0]) && /^[\w:.-]{1,80}$/.test(p[0]) && str(p[1]) && (p[2] === null || str(p[2])) && num(p[3]) ? undefined : "it is not a placeholder";
  // A card's answer: the card is in the store, of that session, and waits (or already stands as the line says).
  if (p.length !== 4 || !str(p[0]) || !str(p[1]) || !str(p[2]) || !str(p[3])) return "it is not a card's answer";
  if (!ANSWERED.has(p[2])) return `a card is never owed the state ${p[2].slice(0, 40)}`;
  const card = facts.card(p[0]);
  if (!card || card.session_id !== p[1]) return "its card is not in the store";
  if (card.state === p[2] && card.data === p[3]) return "made";
  if (card.state !== "pending") return `its card does not wait (it is ${card.state})`;
  let data: { id?: unknown; session_id?: unknown; state?: unknown };
  try { data = JSON.parse(p[3]); } catch { return "its card's record is not JSON"; }
  if (!data || data.id !== p[0] || data.session_id !== p[1] || data.state !== p[2]) return "its card's record is of another card";
  return undefined;
}

// What a file held: its marked lines of one daemon, in order, and what was not taken.
// `why`: the file was not read at all. `torn`: lines that are not whole or not a record.
// `unmarked`: lines without this store's mark. `others`: lines of another daemon than the first's.
// `made`: lines of the file before this one (`before`: its key), which was made already.
export type OwedRead = { lines: OwedLine[]; torn: number; unmarked: number; others: number; made: number; bytes: number; why?: string };
// Undefined: there is no file.
export function readOwed(path: string, key: Uint8Array, before?: Uint8Array): OwedRead | undefined {
  const out: OwedRead = { lines: [], torn: 0, unmarked: 0, others: 0, made: 0, bytes: 0 };
  let fd: number;
  try {
    const st = lstatSync(path);
    out.bytes = st.size;
    if (!st.isFile()) return { ...out, why: "it is not a plain file" };
    if (st.size > 2 * OWED_FILE_MAX) return { ...out, why: `it is ${Math.round(st.size / 1048576)} MB, more than a daemon ever writes there` };
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? undefined : { ...out, why: `it cannot be read (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})` };
  }
  let life: string | undefined;
  const take = (text: string) => {
    if (!text.trim()) return;
    const sp = text.indexOf(" ");
    const mac = text.slice(0, sp), json = text.slice(sp + 1);
    if (sp !== 64 || !/^[0-9a-f]{64}$/.test(mac)) { out.torn++; return; }
    const want = Buffer.from(mark(key, json), "hex"), got = Buffer.from(mac, "hex");
    if (!timingSafeEqual(want, got)) {
      if (before && timingSafeEqual(Buffer.from(mark(before, json), "hex"), got)) out.made++;
      else out.unmarked++;
      return;
    }
    let r: OwedLine | null;
    try { r = JSON.parse(json); } catch { out.torn++; return; }
    if (!r || typeof r !== "object" || !num(r.v) || !str(r.life) || !str(r.op)) { out.torn++; return; }
    life ??= r.life;
    if (r.life !== life) { out.others++; return; }
    out.lines.push(r);
  };
  try {
    // A part at a time: the whole text is never in memory twice.
    if (!fstatSync(fd).isFile()) return { ...out, why: "it is not a plain file" };
    const buf = Buffer.alloc(64 * 1024);
    const dec = new TextDecoder();
    let rest = "";
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      const parts = (rest + dec.decode(buf.subarray(0, n), { stream: true })).split("\n");
      rest = parts.pop()!;
      for (const l of parts) take(l);
    }
    // (A last line with no end is one a kill cut.)
    if (rest.trim()) out.torn++;
  } catch (e) {
    return { ...out, why: `it cannot be read (${(e as Error).message})` };
  } finally {
    closeSync(fd);
  }
  return out;
}
