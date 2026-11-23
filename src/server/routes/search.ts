// Search across sessions: titles and folders first, then what was said and
// done: prompts (with the names of their attached files), reply text, tool
// calls with a bounded excerpt of their input and output, and summaries. The
// index itself is search-index.ts; one made again is filled on a thread
// (search-fill.ts).
import type { RouteModule } from "../app.ts";
import { readsOf } from "../reads.ts";
import { searchLimits } from "../search-query.ts";
import { board } from "./state.ts";
import { initSearchIndex, keepIndexed } from "./search-index.ts";
import { startFill } from "./search-fill.ts";

export { TOOL_EXCERPT, initSearchIndex, keepIndexed } from "./search-index.ts";

type Hit = {
  session_id: string; session_title: string; event_id?: string; kind: string; ts: number; snippet: string; cwd: string; archived: boolean;
  parent_id?: string | null; ref?: string; partial?: boolean;
};

// Case and accents fold the way the transcript index folds them (é = e = É),
// and the canonically equal spellings (a composed é and e + combining accent) are one.
export const fold = (s: string) => s.normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase();

// How well a title holds the words asked for, the lower the better: 0, the words as typed, as whole
// words ("agent 17" in "Agent 17: check the parser", not in "Agent 170"); 1, as typed; 2, each
// somewhere in the title or the folder.
export function titleRank(title: string, words: string[]): number {
  const hay = fold(title), phrase = words.join(" ");
  if (!phrase) return 2;
  for (let at = hay.indexOf(phrase); at >= 0; at = hay.indexOf(phrase, at + 1)) {
    const before = hay[at - 1], after = hay[at + phrase.length];
    const edge = (c: string | undefined) => c === undefined || !/[\p{L}\p{N}]/u.test(c);
    if (edge(before) && edge(after)) return 0;
  }
  return hay.includes(phrase) ? 1 : 2;
}

// Every word must match, the last one as a prefix ("deb func" finds "debounce function").
export function ftsQuery(q: string): string | null {
  const words = q.normalize("NFKC").split(/\s+/).map((w) => w.replace(/"/g, "")).filter(Boolean);
  if (!words.length) return null;
  return words.map((w, i) => `"${w}"${i === words.length - 1 ? "*" : ""}`).join(" ");
}

export const searchRoutes: RouteModule = ({ store, errors }) => {
  const state = initSearchIndex(store.db);
  const kept = keepIndexed(store);
  if (state.fill || state.drain) startFill(store, { oldGone: kept.oldGone, failed: (e, ctx) => errors?.capture("server", e, ctx) });

  return {
    "/api/search": {
      // ?q=words&limit=n (per group: titles and conversation hits are cut apart)
      // [&roots=1: no subagent sessions] [&archived=0|1: one partition]
      // [&cwd=folder] [&sessions=1: one hit per session, the best]
      // What it is limited to, in the query itself or as parameters (search-query.ts):
      //   in:commands (in=commands), since:yesterday (since=), until: (until=), on:yesterday (on=), state:failed (state=).
      //   A limit that is not understood: 400 with `limit: true` and what its name takes.
      // Every hit has `ts`, when it happened; the answer's `limits` says what the search was limited to, in words.
      // [&newest=1: the newest hits first, not the best]
      GET: async (req: Request) => {
        const u = new URL(req.url);
        const asked = (u.searchParams.get("q") ?? "").trim();
        if (asked.length > 500) return Response.json({ error: "query over 500 bytes" }, { status: 400 });
        const limit = Math.min(Number(u.searchParams.get("limit") ?? 20) || 20, 100);
        // The limits a parameter names are the same as the ones written in the query.
        const params = ["in", "since", "until", "on", "state"].map((k) => (u.searchParams.get(k) ? `${k}:${u.searchParams.get(k)!.trim().replace(/\s+/g, "-")}` : "")).filter(Boolean);
        const lim = searchLimits([asked, ...params].join(" "));
        // A limit that was not understood is refused with what its name takes (`limit`: the page shows it as a hint, not a failure).
        if (lim.error) return Response.json({ error: lim.error, limit: true }, { status: 400 });
        const q = lim.words;
        const match = ftsQuery(q);
        if (!match) return Response.json({ query: q, hits: [], ...(lim.said.length ? { limits: lim.said } : {}) });
        const roots = u.searchParams.get("roots") === "1";
        // Subagent sessions name their parent (the agents module adds the column).
        const pid = store.columnExists("sessions", "parent_id") ? "s.parent_id" : "NULL";
        const arch = u.searchParams.get("archived");
        const cwd = u.searchParams.get("cwd");
        const perSession = u.searchParams.get("sessions") === "1";
        const scope: string[] = [];
        const args: (string | number)[] = [];
        if (roots) scope.push(`${pid} IS NULL`);
        if (arch === "0" || arch === "1") { scope.push("s.archived = ?"); args.push(Number(arch)); }
        if (cwd) { scope.push("s.workspace = ?"); args.push(cwd); }
        // The sessions in the state asked for, as the daemon tells it now.
        const inState = lim.state ? Object.entries(board?.all() ?? {}).filter(([, st]) => st.watch === lim.state).map(([id]) => id) : undefined;
        if (inState) {
          if (!inState.length) return Response.json({ query: q, hits: [], limits: lim.said });
          scope.push(`s.id IN (${inState.map(() => "?").join(",")})`);
          args.push(...inState);
        }
        const where = scope.length ? `AND ${scope.join(" AND ")}` : "";
        // What limits the rows of the index: their kind (a command is a call of a shell tool) and their time.
        const rows = { ...(lim.kinds ? { kinds: lim.kinds } : {}), ...(lim.commands ? { commands: true } : {}), ...(lim.since !== undefined ? { since: lim.since } : {}), ...(lim.until !== undefined ? { until: lim.until } : {}) };
        const limited = Object.keys(rows).length > 0;
        // Every word matches the title or folder; matched over all eligible sessions, then ranked and cut.
        const words = fold(q).split(/\s+/).filter(Boolean);
        // A title is no command and has no time of its own: a search limited to a kind of row or a time lists none.
        const titles = limited ? [] : store.db
          .prepare<any, (string | number)[]>(`SELECT s.id, s.title, s.workspace, s.updated, s.archived, ${pid} AS parent_id FROM sessions s WHERE 1 ${where} ORDER BY s.archived, s.updated DESC`)
          .all(...args)
          .filter((t) => { const hay = fold(`${t.title ?? ""} ${t.workspace}`); return words.every((w) => hay.includes(w)); })
          // The titles that hold the words as they were typed come first, the ones that hold them as
          // whole words before those: among hundreds of agents named alike, the one asked for is not
          // cut off behind the newest dozen that share its words.
          .map((t, i) => ({ t, i, rank: titleRank(t.title ?? "", words) }))
          .sort((a, b) => a.rank - b.rank || a.i - b.i)
          .map((x) => x.t)
          .slice(0, limit);
        // The index is read off the loop: one word can match most of a long history.
        const content = await readsOf(store).run("search.content", {
          match, where, args, rows, limit, perSession, pid, newest: u.searchParams.get("newest") === "1",
        });
        const hits: Hit[] = [
          ...titles.map((t) => ({ session_id: t.id, session_title: t.title, kind: "title", ts: t.updated, snippet: t.title, cwd: t.workspace, archived: !!t.archived, parent_id: t.parent_id ?? null })),
          ...content.map((c) => {
            const tool = c.kind === "tool_use" || c.kind === "tool_result";
            return {
              session_id: c.session_id, session_title: c.title, event_id: c.event_id,
              kind: c.kind, ts: c.ts, snippet: c.snippet, cwd: c.workspace, archived: !!c.archived, parent_id: c.parent_id ?? null,
              ...(tool && c.ref ? { ref: c.ref } : {}), ...(c.cut ? { partial: true } : {}),
            };
          }),
        ];
        return Response.json({ query: q, hits, ...(lim.said.length ? { limits: lim.said } : {}) });
      },
    },
  };
};
