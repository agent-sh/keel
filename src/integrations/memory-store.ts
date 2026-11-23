// The owner's memory store as the owner reads and corrects it from Keel:
// its own search, one fact in full, and a correction. Every call is the
// store's own command line (`tacit search --json`, `tacit fact`, `tacit add`):
// Keel never opens the store's files and keeps none of their text.
//
// What the store offers, and what it does not:
// - search and reading a fact: its commands, read-only.
// - a correction: the store takes one as a newer note (`tacit add`) for its
//   curator. That is the one change an agent harness may make, and the one
//   Keel makes. The store has no writer for Keel, so the note is recorded
//   under one of the writers it knows (`writer`), and the owner is told which.
// - editing a fact in place and retiring one are the owner's alone, on the
//   store's own page (`tacit review --fact NAME`), behind a token it prints
//   only to a terminal. Keel has no path there and makes none: it shows the
//   command.
//
// A correction is sent in two steps. The first makes the command and keeps
// its arguments under a one-time id; the second names that id and runs those
// arguments as they were shown, once, within two minutes. Nothing is rebuilt
// between the two, and a request sent again does nothing.
//
// Fail-open like the hooks: a store that is missing, slow or failing is said
// as such (`state`), and nothing waits for it longer than the bounds below.
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { collect } from "../core/proc.ts";
import { registerSettings, settings } from "../admin/settings.ts";

// How long a read of the store is waited for. The store answers a search in
// well under a second; past this it is hung or syncing, and the owner is told.
export const READ_WAIT_MS = 8000;
// A note is committed and pushed by the store: its own commands allow two minutes.
export const WRITE_WAIT_MS = 120_000;
// The store's own page size with a filter and no query.
export const SEARCH_LIMIT = 20;
// What a search and a correction may hold. A query is a few words and a
// correction a few lines: past these it is a paste by mistake, and it is
// refused whole instead of cut (the store's description line holds 200).
export const QUERY_MAX = 1000;
export const CORRECTION_MAX = 2000;
// How much of a result's description a list row shows.
export const DESCRIPTION_SHOWN = 400;
// How long a shown command waits for its confirmation, and how many wait at once.
export const CONFIRM_MS = 120_000;
const PENDING_MAX = 32;

export type StoreState = "ok" | "absent" | "slow" | "failed";
// `err`: what the command wrote beside its answer, whole (its help goes there).
type Ran = { state: StoreState; out: string; err?: string; error?: string; ms: number };

// A fact's name as the store names one: its slug rule, and no longer than a file name.
export const isFactName = (name: unknown): name is string => typeof name === "string" && name.length <= 200 && /^[a-z0-9][a-z0-9-]*$/.test(name);
// A writer of the store as the store names one.
export const isWriter = (w: unknown): w is string => typeof w === "string" && /^[a-z][a-z0-9-]{0,31}$/.test(w);

// The writer of the memory store a correction sent from Keel, and a note the
// store's own tools add, is recorded under. The store has no writer for Keel:
// it runs the store's hooks the way Claude Code does and feeds it transcripts
// in that format, so its notes go to that writer's inbox until the owner names
// another (Settings, or TACIT_HARNESS).
registerSettings("memory", { writer: "claude" }, (v) => (isWriter(v.writer) ? undefined : "writer is one of the store's writers: lower-case letters, digits and dashes"));
export const memoryWriter = (): string => {
  const env = process.env.TACIT_HARNESS?.trim();
  return isWriter(env) ? env : String(settings().memory?.writer ?? "claude");
};

export type Hit = { name: string; description: string; cut: boolean; scope: string; type: string; created: string; score: number | null; inbox: boolean; ruling: boolean; kind: string; path: string };
// `replaced_by`: the fact the store put in this one's place.
export type FactView = { name: string; head: string[]; meta: Record<string, string>; body: string; replaced_by?: string };

// A scalar of the frontmatter without its quotes.
function scalar(v: string): string {
  const t = v.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1).replace(/\\(["\\])/g, "$1");
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1).replace(/''/g, "'");
  return t;
}

// One fact as the store prints it: lines of its own above the file ("# whose:
// ..."), the frontmatter, the body. For a fact it replaced, the store prints
// the newer fact first and this one after a line that names it: the fact
// read here is the one asked for, the part after that line. The frontmatter
// is read flat, a nested key as "source.kind"; nothing here depends on a
// field being there.
export function parseFact(name: string, raw: string): FactView {
  const divider = `\n--- the old fact, ${name} ---\n`;
  const at = raw.indexOf(divider);
  const own = (at >= 0 ? raw.slice(at + divider.length) : raw).split("\n");
  // The store's own lines stand above the first file it prints.
  const lead = (at >= 0 ? raw.slice(0, at) : raw).split("\n");
  const head: string[] = [];
  for (const l of lead) { if (l.trim() === "---") break; if (l.trim()) head.push(l.replace(/^#\s*/, "")); }
  let i = 0;
  while (i < own.length && own[i]!.trim() !== "---") i++;
  const meta: Record<string, string> = {};
  if (i >= own.length) return { name, head: [], meta, body: raw.trim() };
  let parent = "";
  for (i++; i < own.length && own[i]!.trim() !== "---"; i++) {
    const m = /^(\s*)([\w.-]+):\s*(.*)$/.exec(own[i]!);
    if (!m) continue;
    const value = scalar(m[3]!);
    if (!m[1]) { parent = value ? "" : m[2]!; if (value) meta[m[2]!] = value; }
    else if (parent && value) meta[`${parent}.${m[2]}`] = value;
  }
  return { name, head, meta, body: own.slice(i + 1).join("\n").trim(), ...(isFactName(meta.superseded_by) ? { replaced_by: meta.superseded_by } : {}) };
}

// The words of a command line as a shell takes them, for the owner to read and copy.
const quote = (w: string) => (/^[\w@%+=:,./-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`);
export const commandWords = (argv: string[]) => argv.map(quote);
export const commandLine = (argv: string[]) => commandWords(argv).join(" ");

// `page`: the request that asked for the command came from a page (it named an origin).
type Pending = { argv: string[]; name: string; cwd?: string; session?: string; page: boolean; until: number };
// `words`: the command as its arguments, each quoted as a shell takes it (a line breaks between them, never inside a flag).
export type Preview = { state: StoreState | "missing" | "confirm"; error?: string; id?: string; command?: string; words?: string[]; note?: string; writer?: string };
// `no_writer`: the store refused the note because it has no writer of the name the setting holds.
export type Sent = { state: StoreState | "expired"; error?: string; ms: number; name?: string; session?: string; page?: boolean; where?: string; no_writer?: string };

export class MemoryStore {
  // The commands shown and not yet confirmed, by their one-time id.
  private pending = new Map<string, Pending>();

  // `bin`: the store's command line, the one its hooks run.
  // `home`: a folder that always exists, for a session whose own folder does not.
  // `writer`: the writer of the store a correction is recorded under.
  constructor(private bin: () => string | null, private home: string, private writer: () => string = () => "claude", private waits = { read: READ_WAIT_MS, write: WRITE_WAIT_MS, confirm: CONFIRM_MS }) {}

  get available(): boolean {
    return !!this.bin();
  }

  // One command of the store, bounded. The store scopes a search to the
  // repository of the folder it runs in: a session's folder when it is on
  // this machine, else `home` (a folder that is gone or on another machine
  // must not fail the call).
  private async run(args: string[], ms: number, cwd?: string): Promise<Ran> {
    const bin = this.bin();
    const t0 = performance.now();
    const took = () => Math.round(performance.now() - t0);
    if (!bin) return { state: "absent", out: "", ms: 0 };
    let p: ReturnType<typeof Bun.spawn>;
    try {
      // A note is not written in the name of whatever session the daemon itself was started from.
      const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !["CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "CODEX_SESSION_ID", "PI_SESSION_ID", "TACIT_SESSION"].includes(k))) as Record<string, string>;
      p = Bun.spawn([bin, ...args], { cwd: cwd && existsSync(cwd) ? cwd : this.home, stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true, env });
    } catch (e) {
      return { state: "failed", out: "", error: (e as Error).message, ms: took() };
    }
    let late = false;
    const timer = setTimeout(() => { late = true; try { process.kill(-p.pid, "SIGKILL"); } catch {} }, ms);
    try {
      const { out, err, code } = await collect(p as any, "memory store");
      if (late) return { state: "slow", out: "", ms: took() };
      if (code !== 0) return { state: "failed", out, err, error: (err.trim() || out.trim() || `exit ${code}`).split("\n").slice(-3).join(" ").slice(0, 400), ms: took() };
      return { state: "ok", out, err, ms: took() };
    } catch (e) {
      return { state: late ? "slow" : "failed", out: "", error: (e as Error).message, ms: took() };
    } finally {
      clearTimeout(timer);
    }
  }

  // The store's own search, in the store's order, with its score as it gives
  // it. The query goes as one argument, as it was typed.
  async search(query: string, o: { cwd?: string; limit?: number; inbox?: boolean } = {}): Promise<{ state: StoreState; error?: string; ms: number; hits: Hit[] }> {
    const q = query.replace(/\s+/g, " ").trim();
    if (!q) return { state: "ok", ms: 0, hits: [] };
    const args = ["search", "--json", "--limit", String(Math.min(Math.max(Math.floor(o.limit ?? SEARCH_LIMIT), 1), 100))];
    if (o.inbox) args.push("--inbox");
    // After "--": the query is never read as one of the store's options.
    const r = await this.run([...args, "--", q], this.waits.read, o.cwd);
    if (r.state !== "ok") return { state: r.state, error: r.error, ms: r.ms, hits: [] };
    let rows: any;
    try { rows = JSON.parse(r.out.trim() || "null"); } catch { return { state: "failed", error: "the store's answer was not JSON", ms: r.ms, hits: [] }; }
    const s = (v: unknown, max = 200) => (typeof v === "string" ? v.slice(0, max) : "");
    const hits: Hit[] = (Array.isArray(rows) ? rows : []).filter((x) => isFactName(x?.Name)).map((x) => ({
      name: x.Name, description: s(x.Description, DESCRIPTION_SHOWN), cut: typeof x.Description === "string" && x.Description.length > DESCRIPTION_SHOWN,
      scope: s(x.Scope), type: s(x.Type), created: s(x.Created, 40),
      score: typeof x.Score === "number" && Number.isFinite(x.Score) ? x.Score : null, inbox: !!x.Inbox, ruling: !!x.Ruling, kind: s(x.Kind, 40), path: s(x.Path, 400),
    }));
    return { state: "ok", ms: r.ms, hits };
  }

  async fact(name: string, cwd?: string): Promise<{ state: StoreState | "missing"; error?: string; ms: number; fact?: FactView }> {
    const r = await this.run(["fact", name], this.waits.read, cwd);
    // The store says "not found" with a failing exit, or with a line and no file.
    const missing = /not found/i.test(`${r.error ?? ""}\n${r.out}`) && !r.out.includes("\n---");
    if (missing) return { state: "missing", ms: r.ms };
    if (r.state !== "ok") return { state: r.state, error: r.error, ms: r.ms };
    return { state: "ok", ms: r.ms, fact: parseFact(name, r.out.trim()) };
  }

  // What the owner can do about a fact besides correcting it: edit it in
  // place or retire it, on the store's own page. One command for both, which
  // Keel only names.
  ownerPage(name: string) {
    const argv = [basename(this.bin() ?? "tacit"), "review", "--fact", name];
    return {
      command: commandLine(argv), words: commandWords(argv),
      note: "The store keeps editing a fact in place and retiring one to the owner, on its own page. Keel has no command for either: run this in a terminal and change the fact there.",
    };
  }
  // What a correction is, said before one is written.
  readonly correctionNote = "A correction is sent as a newer note for the store's curator, which reads it against this fact when it next runs. Until then nothing changes, and the curator may ask you on its own page before it replaces anything.";

  // The note a correction is: under the fact's own scope and type, said by the owner.
  private correctionArgs(name: string, text: string, f: FactView): string[] {
    const one = text.replace(/\s+/g, " ").trim();
    const args = ["add", "--harness", this.writer(), "--kind", "user"];
    if (f.meta.type && /^[a-z_]+$/.test(f.meta.type)) args.push("--type", f.meta.type);
    // A scope as the store writes one: it starts with a letter, so it is never read as an option.
    if (f.meta.scope && /^[a-z][\w./@-]*$/.test(f.meta.scope)) args.push("--scope", f.meta.scope);
    return [...args, "--desc", one.slice(0, 200), "--body", `Corrects ${name}, which the owner marked wrong in Keel. ${one}`, `${name.slice(0, 180)}-correction`];
  }

  // The command a correction would run, kept under a one-time id for the
  // owner to confirm. The fact is read once, here: what is confirmed is this
  // argument list and no other.
  async preview(name: string, text: string, o: { cwd?: string; session?: string; page?: boolean } = {}): Promise<Preview> {
    const got = await this.fact(name, o.cwd);
    if (got.state !== "ok") return { state: got.state, error: got.error };
    const argv = this.correctionArgs(name, text, got.fact!);
    const now = Date.now();
    for (const [k, p] of this.pending) if (p.until < now) this.pending.delete(k);
    while (this.pending.size >= PENDING_MAX) this.pending.delete(this.pending.keys().next().value!);
    const id = crypto.randomUUID();
    this.pending.set(id, { argv, name, cwd: o.cwd, session: o.session, page: o.page !== false, until: now + this.waits.confirm });
    const writer = this.writer();
    const shown = [basename(this.bin() ?? "tacit"), ...argv];
    return {
      state: "confirm", id, command: commandLine(shown), words: commandWords(shown), note: this.correctionNote,
      writer: `The store will record it as written by its writer ${writer}: it has no writer for Keel. The note's first sentence says it came from Keel.`,
    };
  }

  // Runs a shown command, once: the arguments kept under `id`, as they were
  // shown. An id that was used, never given or is past its time runs nothing.
  // `where`: the note's path, as the store answered it.
  async confirm(id: unknown): Promise<Sent> {
    const p = typeof id === "string" ? this.pending.get(id) : undefined;
    if (!p) return { state: "expired", ms: 0 };
    this.pending.delete(id as string);
    if (p.until < Date.now()) return { state: "expired", ms: 0, name: p.name, session: p.session, page: p.page };
    const r = await this.run(p.argv, this.waits.write, p.cwd);
    // Only a path is taken from the store's answer: never its other words.
    const where = /^added ([\w@./-]{1,300})$/.exec(r.out.trim().split("\n").at(-1) ?? "")?.[1];
    // The store refuses a writer it does not have by name: the setting names one it lacks.
    const writer = p.argv[p.argv.indexOf("--harness") + 1]!;
    const no_writer = r.state === "failed" && /unknown harness|not one an agent may write as/i.test(r.error ?? "") ? writer : undefined;
    return { state: r.state, error: r.error, ms: r.ms, name: p.name, session: p.session, page: p.page, where, no_writer };
  }

  // The writers the store takes a note from, when it says them: its own help
  // names them on one line. Read once per command line; null when it does not say.
  private known: { bin: string; list: string[] | null } | null = null;
  async writers(): Promise<string[] | null> {
    const bin = this.bin();
    if (!bin) return null;
    if (this.known?.bin === bin) return this.known.list;
    const r = await this.run(["add", "--help"], this.waits.read);
    const line = /writer harness, required: ([a-z0-9, -]+)/.exec(`${r.out}\n${r.err ?? ""}`)?.[1];
    const list = line ? line.split(",").map((w) => w.trim()).filter(isWriter) : [];
    if (r.state !== "slow") this.known = { bin, list: list.length ? list : null };
    return list.length ? list : null;
  }
}
