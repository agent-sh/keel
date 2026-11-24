// The provenance books of the sessions (provenance.ts), and what the gate asks of them: the first sighting of a
// target over a session and the sessions above it, whether the owner has since answered for it, and whether the
// workspace held it before.
import type { Store } from "../core/store.ts";
import type { Session } from "../core/types.ts";
import { git } from "../core/git.ts";
import {
  ProvenanceBook, extractTargets, hostOfRemote, held, inputTargets, wholeTargets,
  type Hit, type Origin, type Reach, type SourceOf, type Target,
} from "./provenance.ts";

const MAX_BOOKS = 1024;

export class Provenance {
  private books = new Map<string, ProvenanceBook>();
  // The targets the owner answered a card for, by session: theirs from then on (a restart asks again).
  private cleared = new Map<string, Set<string>>();
  // The agents of the sessions read, by agent id: the session each one is.
  private kids = new Map<string, string>();

  constructor(private store: Store, private source: SourceOf) {}

  private importedUntil(id: string): number {
    try { return this.store.db.query<{ synced_ms: number }, [string]>("SELECT synced_ms FROM import_links WHERE session_id = ?").get(id)?.synced_ms ?? 0; } catch { return 0; } // nothing was imported here
  }

  // A session's book, taken up to its last event; the agents under it first, so a report finds what its agent saw.
  private async bookOf(id: string, depth = 0, seen = new Set<string>()): Promise<ProvenanceBook> {
    seen.add(id);
    if (depth < 4) {
      let rows: { id: string; session_id: string }[] = [];
      try { rows = this.store.db.query<{ id: string; session_id: string }, [string]>("SELECT id, session_id FROM agents WHERE parent_id = ? LIMIT 64").all(id); } catch {} // no agents table
      for (const r of rows) { this.kids.set(r.id, r.session_id); if (!seen.has(r.session_id)) await this.bookOf(r.session_id, depth + 1, seen); }
    }
    let b = this.books.get(id);
    if (!b) {
      if (this.books.size >= MAX_BOOKS) this.books.delete(this.books.keys().next().value!);
      this.books.set(id, (b = new ProvenanceBook(this.source, this.importedUntil(id), (agent) => { const sid = this.kids.get(agent); return sid ? this.books.get(sid) ?? null : null; })));
    }
    // A session not in memory is brought in, and the bodies of the events this book has not read are read, off the loop.
    if (this.store.session(id)) await this.store.warmBodies(id, b.seq + 1);
    // (The events are read a few at a time with a turn of the loop between: a session of big pages is not read in one stretch.)
    await b.take(this.store.events(id, b.seq));
    return b;
  }

  // The session's book first, then those of the sessions above it.
  async chain(session: Session): Promise<{ ids: string[]; books: ProvenanceBook[] }> {
    const ids: string[] = [session.id];
    for (let up = session, n = 0; up.parent_id && n < 32; n++) { ids.push(up.parent_id); up = this.store.session(up.parent_id) ?? up; }
    const books: ProvenanceBook[] = [];
    for (const id of ids) books.push(await this.bookOf(id));
    return { ids, books };
  }

  clear(ids: string[], hits: Hit[]) {
    const set = this.cleared.get(ids[0]!) ?? new Set<string>();
    for (const h of hits) set.add(h.target.key);
    this.cleared.set(ids[0]!, set);
    if (this.cleared.size > MAX_BOOKS) this.cleared.delete(this.cleared.keys().next().value!);
  }

  // The first sighting of a key over the chain: the owner's word wins, then outside content, then a search result.
  // What a session read that it could not keep whole: a target it has no sighting of may be one that was in it.
  private unread(books: ProvenanceBook[]): Origin | undefined {
    for (const b of books) if (b.unbounded) return b.unbounded;
    return undefined;
  }

  private lookup(books: ProvenanceBook[], key: string): Origin | undefined {
    let best: Origin | undefined;
    for (const b of books) {
      const o = b.get(key);
      if (!o) continue;
      if (o.cls === "owner") return o;
      if (!best || (best.cls === "inside" && o.cls !== "inside") || (best.cls === "listed" && o.cls === "outside")) best = o;
    }
    return best;
  }

  // What of `reaches` is held. `dir`: where the call runs (for the repository's own remotes and branches).
  async hits(session: Session, reaches: Reach[], dir: string | null, now = Date.now()): Promise<{ hits: Hit[]; ids: string[] }> {
    const { ids, books } = await this.chain(session);
    if (!reaches.length || !books.some((b) => b.hasOutside())) return { hits: [], ids };
    const repo = dir && !session.machine ? new Repo(dir) : null;
    const own = books[0]!;
    const asked = (workspace: (t: Target) => boolean) => held(
      reaches,
      (key) => this.lookup(books, key),
      (key) => ids.some((id) => this.cleared.get(id)?.has(key)),
      workspace,
      (key, pathq) => books.some((b) => b.covers(key, pathq)),
      () => this.unread(books),
    );
    // What is held before the repository is asked; it is asked (off the loop) only for those.
    const maybe = asked(() => false);
    if (!maybe.length || !repo) return { hits: maybe, ids };
    const mine = new Map<string, boolean>();
    for (const h of maybe) mine.set(h.target.key, await repo.holds(h.target, own));
    void now;
    return { hits: asked((t) => mine.get(t.key) ?? false), ids };
  }

  // The targets a text or an input names that outside content named first, for the judge: not only sends.
  async soft(session: Session, text: string, input: unknown): Promise<Hit[]> {
    const { ids, books } = await this.chain(session);
    if (!books.some((b) => b.hasOutside())) return [];
    const targets = new Map<string, Target>();
    for (const t of [...extractTargets(text.slice(0, 20_000)), ...inputTargets(input)]) targets.set(t.key, t);
    const out: Hit[] = [];
    for (const t of targets.values()) {
      const o = this.lookup(books, t.key);
      if (!o || o.cls === "owner" || o.cls === "inside") continue;
      if (ids.some((id) => this.cleared.get(id)?.has(t.key))) continue;
      out.push({ target: t, how: "send", origin: o });
      if (out.length >= 5) break;
    }
    return out;
  }
}

// What the repository at a folder holds, read when first asked (local git only, bounded, off the loop).
class Repo {
  private remotes?: Map<string, string[]>; // host -> remote keys
  private branches?: Set<string>;
  constructor(private dir: string) {}
  private async git(...args: string[]) {
    const r = await git(this.dir, args, { read: true, timeout: 3_000 }).catch(() => null);
    return r && r.code === 0 ? r.out : null;
  }
  private async readRemotes() {
    if (this.remotes) return this.remotes;
    const m = new Map<string, string[]>();
    for (const line of ((await this.git("remote", "-v")) ?? "").split("\n")) {
      const url = /^\S+\s+(\S+)\s+\(/.exec(line)?.[1];
      if (!url) continue;
      for (const t of wholeTargets(url, true)) if (t.kind === "remote") { const h = hostOfRemote(t.key); m.set(h, [...(m.get(h) ?? []), t.key]); }
    }
    return (this.remotes = m);
  }
  // Whether the workspace held it before the session: a remote of the repository (not one the session added), a
  // branch it has (not one the session made), a host of its remotes, a mail address or host its files name.
  async holds(t: Target, book: ProvenanceBook): Promise<boolean> {
    const said = (s: string) => book.edited.some((c) => c.toLowerCase().includes(s.toLowerCase()));
    if (t.kind === "remote") return !!(await this.readRemotes()).get(hostOfRemote(t.key))?.includes(t.key) && !said(t.key.slice(7 + hostOfRemote(t.key).length + 1));
    if (t.kind === "branch") {
      if (book.made.has(t.key)) return false;
      this.branches ??= new Set(((await this.git("for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes")) ?? "").split("\n").flatMap((b) => [b, b.replace(/^[^/]+\//, "")]).filter(Boolean));
      return this.branches.has(t.shown);
    }
    if (t.kind === "host" && (await this.readRemotes()).has(t.shown) && !said(t.shown)) return true;
    // A file the repository tracks names it (as of the last commit: what the session wrote since is not "before").
    return (await this.git("grep", "-q", "-I", "-F", "-e", t.shown, "HEAD", "--")) !== null;
  }
}
