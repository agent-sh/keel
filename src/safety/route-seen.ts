// Which provider saw which session's content, by purpose, from the ledger's
// rows: the pure part of GET /api/content-routes. An agent's calls are its
// root session's (the content it read is the root's), counted with the
// agents that made them, and each call is held against the rule as it stands
// now, with the folders of the session that made it (a worktree session's
// being its repository's, as the rule reads them: originOf).
import { allowedFor, allows, folderEntry, originOf, type RouteRule, type Spell } from "./route-rule.ts";

export type SeenRow = { session_id: string; purpose: string; provider: string; calls: number; last_ms: number };
// `wt_root`, `wt_path`: the session's worktree of Keel's (its repository's root and its own path), if any.
export type SeenSession = { id: string; workspace: string; parent_id: string | null; title: string; wt_root?: string | null; wt_path?: string | null };
export type SeenCall = { purpose: string; provider: string; calls: number; crossing: number; last_ms: number };
export type SeenRoot = { id: string; title: string; agents: number; calls: number; crossing: number; rows: SeenCall[] };
export type SeenFolder = { folder: string; allowed: string[] | null; by: string | null; calls: number; crossing: number; providers: Record<string, number>; sessions: SeenRoot[] };
export type Seen = { calls: number; crossing: number; folders: SeenFolder[] };

export function seenBy(rows: readonly SeenRow[], sessions: readonly SeenSession[], rule: RouteRule, home: string, spell: Spell = (p) => p): Seen {
  // Each folder spelled once (spell may ask the disk).
  const spelled = new Map<string, string>();
  const sp: Spell = (p) => { let v = spelled.get(p); if (v === undefined) spelled.set(p, (v = spell(p))); return v; };
  const byId = new Map(sessions.map((s) => [s.id, { ...s, workspace: s.workspace ? originOf(s.workspace, s.wt_root && s.wt_path ? { repo_root: s.wt_root, path: s.wt_path } : null) : s.workspace }]));
  const chain = (id: string) => {
    const out: SeenSession[] = [];
    for (let s = byId.get(id), i = 0; s && i < 32; s = s.parent_id ? byId.get(s.parent_id) : undefined, i++) out.push(s);
    return out;
  };
  const folders = new Map<string, SeenFolder>();
  const roots = new Map<string, SeenRoot & { kids: Set<string> }>();
  let calls = 0, crossing = 0;
  for (const r of rows) {
    const line = chain(r.session_id);
    const root = line.at(-1) ?? { id: r.session_id, workspace: "", parent_id: null, title: "(removed)" };
    const allowed = allowedFor(rule, [...new Set(line.map((s) => s.workspace).filter(Boolean))], home, sp);
    const out = allows(allowed, r.provider) ? 0 : r.calls;
    calls += r.calls;
    crossing += out;
    let f = folders.get(root.workspace);
    if (!f) {
      const e = root.workspace ? folderEntry(rule, root.workspace, home, sp) : null;
      f = { folder: root.workspace, allowed: e?.providers ?? null, by: e?.by ?? null, calls: 0, crossing: 0, providers: {}, sessions: [] };
      folders.set(root.workspace, f);
    }
    f.calls += r.calls;
    f.crossing += out;
    f.providers[r.provider] = (f.providers[r.provider] ?? 0) + r.calls;
    let s = roots.get(root.id);
    if (!s) {
      s = { id: root.id, title: root.title, agents: 0, calls: 0, crossing: 0, rows: [], kids: new Set() };
      roots.set(root.id, s);
      f.sessions.push(s);
    }
    if (r.session_id !== root.id) s.kids.add(r.session_id);
    s.agents = s.kids.size;
    s.calls += r.calls;
    s.crossing += out;
    const row = s.rows.find((x) => x.purpose === r.purpose && x.provider === r.provider);
    if (row) { row.calls += r.calls; row.crossing += out; row.last_ms = Math.max(row.last_ms, r.last_ms); }
    else s.rows.push({ purpose: r.purpose, provider: r.provider, calls: r.calls, crossing: out, last_ms: r.last_ms });
  }
  const list = [...folders.values()].sort((a, b) => b.crossing - a.crossing || b.calls - a.calls);
  for (const f of list) {
    f.sessions.sort((a, b) => b.crossing - a.crossing || b.calls - a.calls);
    for (const s of f.sessions) {
      delete (s as { kids?: unknown }).kids;
      s.rows.sort((a, b) => b.crossing - a.crossing || b.calls - a.calls);
    }
  }
  return { calls, crossing, folders: list };
}
