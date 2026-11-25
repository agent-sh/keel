// Settings > Usage, Memory: what the agent was told to remember, and what
// that cost. Four views of one thing.
// - Usage: what memory costs the turns and whether they use it, one row per
//   recall path (the memory store's blocks at a session's start, with a prompt
//   and with a tool call; the helper's records), from the daemon's own
//   measurement (/api/telemetry/memory). Counts, tokens and times only.
// - Given: what one session was told, moment by moment (/api/memory/given:
//   names and ids, no text).
// - Search: the store's own search, in its order.
// - Never named: per fact, how often it was given and whether a turn named it
//   afterwards (a rough signal), the never named first; tokens per session
//   and per day.
// A fact opens beside the list at a desk, where it stays in view while the
// list scrolls, and under its own row on a phone. It comes after its row in
// the page, takes the keyboard when it opens without moving the page, and
// gives it back to the row it was opened from, which is brought back into
// view when the list has settled.
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { api, reportError } from "../lib/store.ts";
import { fmtTokens } from "../lib/utils.ts";
import { FactReader, GivenView, SearchView, UnusedView, type MemorySession, type OpenFact } from "./MemoryFacts.tsx";
import { MemorySweep } from "./MemorySweep.tsx";
import { Seg, tabId } from "./Seg.tsx";
import { fmtMs, fmtPct, Panel, Table } from "./UsagePanel.tsx";

type Row = {
  asked: number; recalls: number; empty: number; repeat: number; skipped: number; late: number; later: number; timeouts: number; failures: number;
  facts: number; tokens: number; facts_checked: number; used: number; rules: number; rules_checked: number; followed: number; broken: number; recalls_checked: number; recalls_used: number;
  repeats: number; cut: number; wait_ms: number; wait_max_ms: number; proc_ms: number;
};
// `store`: how the memory store answers right now (the kinds of call that are out, or often late).
type Kinds = { ask: boolean; tool: boolean };
// `fell`: paths whose recall in the last two hours is half of their day's or less (answered asks, and those with facts).
type Fell = { path: string; recent: { answered: number; hits: number }; day: { answered: number; hits: number } };
type Report = { total: Row; paths: (Row & { path: string })[]; store?: { out: Kinds; degraded: Kinds }; fell?: Fell[] };
export type MemoryTab = "usage" | "given" | "search" | "unused" | "sweep";

// A path's name: "Memory store, with a prompt", and on a phone "With a prompt".
const STORE = "Memory store, ";
const pathLabel = (path: string): ReactNode => {
  const name = PATH[path] ?? path;
  return name.startsWith(STORE) ? <><span className="max-sm:hidden">{STORE}</span>{name.slice(STORE.length)}</> : name;
};
const PATH: Record<string, string> = {
  store_start: "Memory store, session start",
  store_prompt: "Memory store, with a prompt",
  store_tool: "Memory store, with a tool call",
  store_owed: "Memory store, carried to a later step",
  helper: "Helper records",
};
const HINT: Record<MemoryTab, string> = {
  usage: "what recall added to turns, and an estimate of whether they used it; counts only, no content",
  given: "what a session was told to remember, moment by moment, and what each fact cost",
  search: "the store's own search; a fact opens with its source and date",
  unused: "notes given and never named afterwards (a rough signal), rules followed or broken, and what memory costs",
  sweep: "the helper's daily look at how each memory system did, and what it offers to improve",
};
const PANEL = "memory-view";
const PHONE = "(max-width: 767px)";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
// Whether a media query holds now.
const useMedia = (query: string): boolean => useSyncExternalStore(
  (f) => { const m = matchMedia(query); m.addEventListener("change", f); return () => m.removeEventListener("change", f); },
  () => matchMedia(query).matches,
);

// What recall added to turns: the report of the range. The other views do not wait for it.
function UsageTable({ since }: { since: number }) {
  const [r, setR] = useState<Report | null>(null);
  useEffect(() => {
    let live = true;
    // `since` is the range's own start: it moves when the range does, and this reads again.
    api<Report>(`/api/telemetry/memory?since_ms=${since}`).then((x) => live && setR(x)).catch(reportError);
    return () => { live = false; };
  }, [since]);
  if (!r) return <p className="text-caption text-faint" data-testid="memory-usage-loading">Reading what memory added in this range</p>;
  const cells = (label: ReactNode, x: Row): ReactNode[] => {
    const why = [x.skipped && `${x.skipped} not asked`, x.empty && `${x.empty} with nothing to add`, x.repeat && `${x.repeat} already in the context`, x.late && `${x.late} not waited for`, x.later && `${x.later} answered after the turn went on, carried to a later step`, x.timeouts && `${x.timeouts} timed out`, x.failures && `${x.failures} failed`].filter(Boolean).join(", ");
    const notes = x.facts_checked - x.rules_checked;
    return [
      // A phone has room for the path on two lines, not on one: it wraps there, whole, and leaves
      // out the words every path shares (the panel is Memory).
      <span className="block first-letter:uppercase max-sm:whitespace-normal">{label}</span>,
      <span title={why || undefined}>{x.recalls} <span className="text-faint">of {x.asked}</span></span>,
      <span title={plural(x.facts, "fact")}>{fmtTokens(x.tokens)}</span>,
      notes
        ? <span title={`${x.used} of ${plural(notes, "note")} named by the reply or a tool call of their turn`}>{x.recalls_used} <span className="text-faint">of {x.recalls_checked}<span className="max-sm:hidden">, {fmtPct(x.used / notes)} of notes</span></span></span>
        : <span className="text-faint">{x.recalls_checked ? "no notes" : "none yet"}</span>,
      // A rule works by what the model leaves undone: followed while the call it forbids is not made, broken once it is.
      x.rules
        ? <span title={`${plural(x.rules, "rule")} given: ${x.followed} followed, ${x.broken} broken, ${x.rules - x.followed - x.broken} not judged (no call to judge them by, or their turn is not over)`} data-testid="memory-rules-cell">{x.followed} <span className="text-faint">followed, </span>{x.broken}<span className="text-faint"> broken</span></span>
        : <span className="text-faint">none</span>,
      <span title={x.cut ? `${x.cut} more had no room in their block and followed with a later step` : undefined}>{x.repeats}{x.cut ? <span className="text-faint">, {x.cut} carried on</span> : null}</span>,
      <span title={`longest wait ${fmtMs(x.wait_max_ms)}; the memory hook ran for ${fmtMs(x.proc_ms)} in all, waited for or not`}>{fmtMs(x.wait_ms)}</span>,
    ];
  };
  const out = r.total.timeouts + r.total.failures;
  const kinds = (k?: Kinds) => [k?.ask && "prompts", k?.tool && "tool calls"].filter(Boolean).join(" and ");
  const slow = kinds(r.store?.degraded), down = kinds(r.store?.out);
  if (!r.paths.length) return <p className="k-empty">No memory was recalled in this range.</p>;
  return (
    <>
      <Table
        head={["Path", "Recalls", "Tokens added", "Notes named (estimate)", "Rules", "Not added again", "Time added"]}
        rows={[...r.paths.map((p) => cells(pathLabel(p.path), p)), ...(r.paths.length > 1 ? [cells(<span className="font-medium">All memory</span>, r.total)] : [])]}
        // A phone keeps what the table is opened for: how often memory was added, what it cost, whether it was used
        // (the rules, the repeats and the time are in the wider table and the Never named view).
        wide={[4, 5, 6]}
      />
      <p className="mt-3 border-t border-line pt-3 text-caption text-muted" data-testid="memory-notes">
        Notes named is an estimate: a recall counts when the reply or a tool call of its turn spells the name of one of its notes, or three of its words in a row. It reads low: a note can shape a reply without being named. A rule works by what the model leaves undone, so it is judged on the call it forbids: followed while that call is not made in the session after the rule was given, broken once it is; a call the store refused is the rule acting, and a rule that names no call is not counted either way. A fact the context already holds is not added again; one its block has no room for follows with the next step.
        {r.fell?.map((f) => (
          <span key={f.path} className="text-warn" data-testid="memory-fell"> Recall fell for {(PATH[f.path] ?? f.path).replace(/^./, (c) => c.toLowerCase())}: facts came with {f.recent.hits} of its last {f.recent.answered} answers in two hours, against {f.day.hits} of {f.day.answered} in the day before.</span>
        ))}
        {out > 0 && <span className="text-danger" data-testid="memory-out"> The store did not answer {plural(out, "time")} ({r.total.timeouts} timed out, {r.total.failures} failed): those turns went on without it.</span>}
        {down && <span className="text-danger" data-testid="memory-down"> Right now it is not answering {down} in time.</span>}
        {slow && !down && <span className="text-warn" data-testid="memory-slow"> Right now it answers {slow} slowly: a quarter or more of its last 20 answers came later than a turn waits.</span>}
      </p>
    </>
  );
}

// `session`: the session the panel was opened for; `tab`: the view to start
// on; `onTab`: told which view shows (the range above applies to two of them).
export function MemoryUsage({ since, session: from = "", tab: first = "usage", onTab }: { since: number; session?: string; tab?: MemoryTab; onTab?: (t: MemoryTab) => void }) {
  const [tab, setTab] = useState<MemoryTab>(first);
  const [session, setSession] = useState(from);
  const [sessions, setSessions] = useState<MemorySession[]>([]);
  // The open fact, and the row it was opened from (`key`: a fact can stand in several rows).
  const [open, setOpen] = useState<{ name: string; key: string } | null>(null);
  // The session the panel was opened for is gone: said once, and the views go on over all sessions.
  const [deleted, setDeleted] = useState(false);
  // Search keeps its query and its results while another view shows.
  const [searched, setSearched] = useState(first === "search");
  const phone = useMedia(PHONE);
  const opener = useRef<HTMLElement | null>(null);
  const openFact: OpenFact = (name, el, key) => { opener.current = el; setOpen({ name, key }); };
  const lost = () => { setDeleted(true); setSession(""); setOpen(null); opener.current = null; };
  useEffect(() => { onTab?.(tab); if (tab === "search") setSearched(true); }, [tab]);
  // After the list took its new shape (the fact opened beside it or under its
  // row, or closed): the row it was opened from is in view again. On a phone
  // an opened fact stands under its row, and the row goes to the top of the
  // view so the fact is read from its start. Closed, the row has the keyboard.
  useLayoutEffect(() => {
    const el = opener.current;
    if (!el?.isConnected) return;
    if (open && phone) (el.closest("[data-row]") ?? el).scrollIntoView({ block: "start" });
    else el.scrollIntoView({ block: "nearest" });
    if (!open) { el.focus({ preventScroll: true }); opener.current = null; }
  }, [open, phone]);
  useEffect(() => {
    if (tab === "usage" || tab === "search" || tab === "sweep") return;
    let live = true;
    api<{ sessions: MemorySession[]; gone: boolean }>(`/api/memory/sessions${session ? `?with=${session}` : ""}`).then((x) => {
      if (!live) return;
      setSessions(x.sessions);
      if (x.gone) lost();
    }).catch(reportError);
    return () => { live = false; };
  }, [tab, session]);
  // What one session was given needs a session: the one the panel was opened for, else the latest.
  const one = session || sessions[0]?.session_id || "";

  // Under its row the fact grows when its text arrives: the row goes back to the top of the view.
  const settle = () => { if (phone && opener.current?.isConnected) (opener.current.closest("[data-row]") ?? opener.current).scrollIntoView({ block: "start" }); };
  const reader = open && <FactReader name={open.name} session={tab === "given" ? one : session} onClose={() => setOpen(null)} onOpen={(n) => setOpen({ name: n, key: open.key })} onRead={settle} />;
  // On a phone the open fact stands under its own row, inside the list.
  const under = (key: string) => (phone && open?.key === key ? <li className="list-none py-2" data-testid="memory-fact-under">{reader}</li> : null);
  const pick = (id: string) => { setDeleted(false); setSession(id); };
  const view = tab === "usage" ? <UsageTable since={since} />
    : tab === "given" ? <GivenView session={one} sessions={sessions} onSession={pick} onOpen={openFact} onGone={lost} under={under} />
    : tab === "search" ? null
    : tab === "sweep" ? <MemorySweep />
    : <UnusedView since={since} session={session} sessions={sessions} onSession={pick} onOpen={openFact} onGone={lost} under={under} />;
  const beside = !!open && !phone && tab !== "usage" && tab !== "sweep";

  return (
    <Panel plain title="Memory" hint={HINT[tab]} testid="usage-memory"
      aside={<Seg<MemoryTab> wrap label="Memory view" kind="tabs" panel={PANEL} testid="memory-tabs" value={tab} onChange={(t) => { setTab(t); setOpen(null); opener.current = null; }} options={[
        { value: "usage", label: "Usage", testid: "memory-tab-usage" }, { value: "given", label: "Given", testid: "memory-tab-given" },
        { value: "search", label: "Search", testid: "memory-tab-search" }, { value: "unused", label: "Never named", testid: "memory-tab-unused" },
        { value: "sweep", label: "Daily sweep", testid: "memory-tab-sweep" },
      ]} />}>
      <div id={PANEL} role="tabpanel" aria-labelledby={tabId(PANEL, tab)} className={beside ? "grid items-start gap-6 md:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]" : undefined}>
        <div className="min-w-0">
          {deleted && tab !== "usage" && <p className="mb-3 rounded-md border border-line bg-sunken px-3 py-2 text-caption text-muted" role="status" data-testid="memory-session-gone">The session this was opened for was deleted, and what it was given went with it. Showing {tab === "given" ? "the latest session memory was given to" : "all sessions"}.</p>}
          {view}
          {searched && <div hidden={tab !== "search"}><SearchView session={session} onOpen={openFact} under={under} /></div>}
        </div>
        {/* Beside the list the fact stays in view while the list scrolls; one taller than the window scrolls in itself. */}
        {beside && <div className="min-w-0 md:sticky md:top-4 md:max-h-[calc(100dvh-2rem)] md:overflow-y-auto" data-testid="memory-fact-beside">{reader}</div>}
      </div>
    </Panel>
  );
}
