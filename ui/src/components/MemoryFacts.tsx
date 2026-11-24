// The Memory panel's views of the facts themselves.
// - Given: what one session was told to remember, as it happened: a line down
//   the page with a mark for each moment the store spoke (the session's
//   start, a prompt, a tool call, a compaction), and under each mark the
//   facts it handed over, what each cost and whether the turn named it after.
// - Search: the store's own search, in its order.
// - Never named: the facts given and never named afterwards, each with a bar
//   for how often it was given, then the rest; what memory cost per day and
//   per session.
// - One fact in full, read from the store when it is opened, with what the
//   owner can do about it. A change goes through the store's own command,
//   after the owner confirmed it.
// A long list is read a part at a time (Newer and Older), never as one page.
// Whatever the store printed is shown with its hidden characters spelled out
// (lib/hidden-chars.ts): a name or a line never reads as something it is not.
import { Switch } from "@base-ui/react/switch";
import { Search, X } from "lucide-react";
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { spellHidden } from "../lib/hidden-chars.ts";
import { api, reportError } from "../lib/store.ts";
import { navigate, setUI } from "../lib/ui.ts";
import { clock, cn, fmtTokens, when } from "../lib/utils.ts";
import { CommandWords } from "./CommandWords.tsx";
import { confirmAction } from "./Confirm.tsx";
import { CopyButton } from "./CopyButton.tsx";
import { Select } from "./Select.tsx";
import { Stat, Stats } from "./Stat.tsx";

type State = "ok" | "absent" | "slow" | "failed" | "missing" | "expired";
export type MemorySession = { session_id: string; title: string | null; last: number; facts: number };
type GivenRow = { id: number; ts: number; recall: number; path: string; hook: string; name: string; call: string | null; ref: string | null; tokens: number; used: number | null; rule: number; held: number | null; open: boolean };
type Given = { available: boolean; rows: GivenRow[]; more: boolean; total: number; tokens: number; named: number; checked: number; blocks: number; block_tokens: number; facts: number };
type Hit = { name: string; description: string; cut: boolean; scope: string; type: string; created: string; score: number | null; inbox: boolean; ruling: boolean; kind: string; path: string };
type FactAnswer = {
  state: State; error?: string; correct: { note: string }; page: { command: string; words: string[]; note: string };
  fact?: { name: string; head: string[]; meta: Record<string, string>; body: string; replaced_by?: string };
};
type FactRow = { name: string; given: number; sessions: number; checked: number; used: number; rule: number; followed: number; broken: number; tokens: number; last: number };
type Efficiency = {
  available: boolean; total_facts: number; facts: FactRow[];
  kinds?: { rules: number; rule_rows: number; followed: number; broken: number; unjudged: number; notes: number; note_rows: number; used: number; unused: number };
  sessions: { session_id: string; title: string | null; gone: number; tokens: number; recalls: number; facts: number }[];
  days: { day: string; tokens: number; recalls: number; sessions: number }[];
  calls: { asked: number; added: number; empty: number; late: number; failed: number; repeat: number; tokens: number };
};
// A fact opened from a row. `key` names the row (a fact can stand in several): on a phone the fact opens
// under that row, and the row takes the keyboard back when the fact closes.
export type OpenFact = (name: string, from: HTMLElement | null, key: string) => void;
// What a list shows under the row `key`: the open fact, on a phone.
export type Under = (key: string) => ReactNode;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const titleOf = (s: { title: string | null; gone?: number }) => (s.gone ? "A deleted session" : s.title?.trim() || "Untitled session");
const gone = (e: unknown) => (e as { status?: number })?.status === 404;
const pct = (n: number, of: number) => (of ? `${Math.round((100 * n) / of)}%` : "none");
// What the store's trouble is, in the owner's words.
const TROUBLE: Record<Exclude<State, "ok">, string> = {
  absent: "The memory store is not installed on this machine, so there is nothing to read. What Keel recorded of earlier sessions still shows.",
  slow: "The memory store did not answer in time. Nothing waits for it: try again in a moment.",
  failed: "The memory store failed to answer.",
  missing: "The store holds no fact of this name any more.",
  expired: "The confirmation was used already or came too late. Nothing was sent: send the correction again.",
};
const ABSENT = "The memory store is not installed on this machine now. This is what Keel recorded; a fact cannot be opened until the store is back.";
const RULES = "A rule often works by what the model does not do, so it is judged on the call it forbids: the command of the store's key for it, else a command its text forbids in backquotes. It is followed while no such call is made in the session after it was given, and broken once one is. A call the store refused counts as the rule acting. A rule that names no call is not judged.";
const ROUGH = "A rough signal, and it reads low: a fact counts as named when its name, three of its words in a row (not all common ones), or a path, file, flag or quoted command it names appeared in the model's later text or tool input of the turn it was given. This is about notes: a rule is judged by the call it forbids.";
const HOOK: Record<string, string> = {
  "session-start": "At the session's start", "session-start:compact": "After a compaction", "session-start:clear": "After a clear", prompt: "With a prompt", "pre-tool": "Before a tool",
};
// How many rows a list shows at once; and how many given rows the daemon sends in one part.
const PART = 20;
const GIVEN_PART = 40;

const selectClass = "max-w-full min-w-0";
// A fact's name is shown whole: it wraps, it is never cut.
const nameButton = "min-w-0 rounded-sm text-left font-mono text-caption text-fg underline decoration-line-strong underline-offset-4 [overflow-wrap:anywhere] hover:decoration-accent focus-visible:outline-2 focus-visible:outline-accent";
const pagerButton = "k-btn k-btn-lg";

// The store's text with what cannot be seen spelled out. `lines`: a text of many lines keeps its breaks and tabs.
function Shown({ text, lines }: { text: string; lines?: boolean }) {
  const parts = spellHidden(text, lines ? "\n\t" : "");
  if (parts.length === 1 && !parts[0]!.hidden) return <>{text}</>;
  return <>{parts.map((p, i) => (p.hidden ? <span key={i} title={p.hidden.name} className="rounded-sm bg-sunken px-0.5 font-mono text-micro text-muted">{p.hidden.shown}</span> : <span key={i}>{p.text}</span>))}</>;
}

function Trouble({ state, error, onRetry }: { state: Exclude<State, "ok">; error?: string; onRetry?: () => void }) {
  return (
    <div className="k-empty" role="status" data-testid="memory-trouble" data-state={state}>
      <b>{state === "absent" ? "No memory store" : state === "slow" ? "The store is slow" : state === "missing" ? "Not in the store" : state === "expired" ? "Not sent" : "The store failed"}</b>
      {TROUBLE[state]}{error ? <> It said: <Shown text={error.slice(0, 400)} /></> : null}
      {onRetry && state !== "absent" && (
        <div className="k-empty-act">
          <button type="button" onClick={onRetry} className={pagerButton} data-testid="memory-retry">Try again</button>
        </div>
      )}
    </div>
  );
}

// Which part of a list shows, and the way to the parts beside it.
function Pager({ from, to, of, onNewer, onOlder, words = ["Newer", "Older"], testid }: { from: number; to: number; of: number; onNewer?: () => void; onOlder?: () => void; words?: [string, string]; testid?: string }) {
  if (!onNewer && !onOlder) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 pt-1" data-testid={testid}>
      <span className="mr-auto text-caption tabular-nums text-faint" data-testid="memory-part">{from} to {to} of {of}</span>
      <button type="button" className={pagerButton} disabled={!onNewer} onClick={onNewer} data-testid="memory-newer">{words[0]}</button>
      <button type="button" className={pagerButton} disabled={!onOlder} onClick={onOlder} data-testid="memory-older">{words[1]}</button>
    </div>
  );
}

export function SessionPick({ sessions, value, onChange, all }: { sessions: MemorySession[]; value: string; onChange: (id: string) => void; all?: boolean }) {
  return (
    <Select aria-label="Session" data-testid="memory-session" value={value} onChange={(e) => onChange(e.target.value)} className={cn(selectClass, "w-80")}>
      {all && <option value="">All sessions</option>}
      {sessions.map((s) => <option key={s.session_id} value={s.session_id}>{titleOf(s)}</option>)}
    </Select>
  );
}

// Whether the turn named a fact after it was given: a mark and its word.
function Named({ g }: { g: GivenRow }) {
  // A rule works by what the model leaves undone: it is followed or broken, never named or not.
  if (g.rule) {
    const [word, mark, why] = g.held === 1 ? ["followed", "border-ok bg-ok", "The call it forbids was not made after it was given"]
      : g.held === 0 ? ["broken", "border-danger bg-danger", "The call it forbids was made after it was given"]
      : g.open ? ["turn not over", "border-dashed border-line-strong", "Its turn still runs: it is judged when the turn ends"]
      : ["rule, no call to judge", "border-dashed border-line-strong", "It names no call the model could make or leave, so it is neither followed nor broken here"];
    return (
      <span className={cn("inline-flex shrink-0 items-center gap-1.5 text-caption", g.held === null ? "text-muted" : "text-fg")} title={why} data-testid="memory-given-held" data-held={g.held ?? undefined}>
        <span className={cn("size-2 rounded-full border-[1.5px]", mark)} aria-hidden />{word}
      </span>
    );
  }
  const [word, mark, why] = g.used === 1 ? ["named", "border-ok bg-ok", undefined]
    : g.used === 0 ? ["not named", "border-line-strong", undefined]
    : g.open ? ["turn not over", "border-dashed border-line-strong", "Its turn still runs: it is checked when the turn ends"]
    : ["not checked", "border-dashed border-line-strong", "Its turn was cut before it ended, so it was never checked"];
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1.5 text-caption", g.used === 1 ? "text-fg" : "text-muted")} title={why} data-testid="memory-given-used">
      <span className={cn("size-2 rounded-full border-[1.5px]", mark)} aria-hidden />{word}
    </span>
  );
}

// What one session was told to remember, as it happened, the newest moment first.
export function GivenView({ session, sessions, onSession, onOpen, onGone, under }: { session: string; sessions: MemorySession[]; onSession: (id: string) => void; onOpen: OpenFact; onGone: () => void; under: Under }) {
  const [r, setR] = useState<Given | null>(null);
  // The parts walked so far: each is the id its rows come before (none for the newest part).
  const [parts, setParts] = useState<(number | null)[]>([null]);
  const at = parts.at(-1) ?? null;
  useEffect(() => { setParts([null]); }, [session]);
  useEffect(() => {
    if (!session) return;
    let live = true;
    api<Given>(`/api/memory/given?session_id=${session}${at === null ? "" : `&before=${at}`}`).then((x) => live && setR(x)).catch((e) => (gone(e) ? live && onGone() : reportError(e)));
    return () => { live = false; };
  }, [session, at]);
  if (!sessions.length && !session) return <p className="k-empty" data-testid="memory-given-empty">Memory has told no session anything yet. Each fact the store hands to a session is listed here as it happens.</p>;

  // The rows of one moment: the facts one answer of the store carried.
  const moments: GivenRow[][] = [];
  for (const g of r?.rows ?? []) {
    const last = moments.at(-1);
    if (last && last[0]!.recall === g.recall) last.push(g);
    else moments.push([g]);
  }
  const what = (g: GivenRow): ReactNode => {
    if (g.hook === "pre-tool") return <>{HOOK[g.hook]}{g.call ? <>, <span className="font-mono text-caption">{g.call}</span></> : ", an earlier call"}</>;
    if (g.hook === "prompt" && g.ref) {
      return <>With <a href={`/s/${session}?e=${g.ref}`} onClick={(e) => { e.preventDefault(); setUI({ focusEvent: g.ref }); navigate({ name: "session", id: session }); }} className="underline decoration-line-strong underline-offset-4 hover:decoration-accent">a prompt</a></>;
    }
    return HOOK[g.hook] ?? g.hook;
  };
  const day = (ts: number) => new Date(ts).toDateString();
  return (
    <div className="flex flex-col gap-4" data-testid="memory-given">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <SessionPick sessions={sessions} value={session} onChange={onSession} />
      </div>
      {r && (
        <p className="max-w-[46rem] text-read text-fg" data-testid="memory-given-total">
          This session was told {plural(r.facts, "fact")} at {plural(r.blocks, "moment")}, which added about {fmtTokens(r.block_tokens)} tokens to its context.
          <span className="text-muted"> {r.checked ? `The model named ${r.named} of the ${r.checked} checked afterwards.` : "None has been checked yet."}{r.facts > r.total ? ` ${plural(r.facts - r.total, "line")} had no name to list.` : ""}</span>
        </p>
      )}
      {r && !r.available && <p className="text-caption text-muted" data-testid="memory-absent">{ABSENT}</p>}
      {!r ? <p className="text-caption text-faint">Reading what was given</p> : !r.rows.length ? <p className="k-empty">The store has told this session nothing.</p> : (
        <ol className="flex max-w-[52rem] flex-col" data-testid="memory-moments">
          {moments.map((m, i) => {
            const g = m[0]!;
            const newDay = i === 0 || day(moments[i - 1]![0]!.ts) !== day(g.ts);
            return (
              <li key={g.recall} className="grid grid-cols-[2.75rem_0.75rem_minmax(0,1fr)] gap-x-2.5 md:grid-cols-[3.25rem_0.75rem_minmax(0,1fr)] md:gap-x-3" data-testid="memory-moment" data-hook={g.hook}>
                <time className="pt-px text-right text-caption tabular-nums text-faint" dateTime={new Date(g.ts).toISOString()} title={when(g.ts)}>{clock(g.ts)}</time>
                {/* The line down the page, and this moment's mark on it. */}
                <span className="relative flex justify-center" aria-hidden>
                  <span className={cn("absolute w-px bg-line", i === 0 ? "top-2" : "top-0", i === moments.length - 1 && !r.more ? "h-2" : "bottom-0")} />
                  <span className="relative mt-[0.3125rem] size-2 rounded-full bg-fg ring-4 ring-bg" />
                </span>
                <div className="min-w-0 pb-5">
                  <div className="flex flex-wrap items-baseline gap-x-2 text-ui">
                    <span className="font-medium text-fg">{what(g)}</span>
                    {g.path === "store_owed" && <span className="text-caption text-muted" title="Its block was full or the store answered late, so it joined a later step">carried to a later step</span>}
                    {newDay && <span className="text-caption text-faint">{clock(g.ts, { date: true, weekday: true }).replace(/,?\s*\d{2}:\d{2}$/, "")}</span>}
                  </div>
                  <ul className="mt-1 flex flex-col">
                    {m.map((f) => (
                      <Fragment key={f.id}>
                        <li data-testid="memory-given-row" data-row="" data-name={f.name} data-hook={f.hook} className="flex scroll-mt-32 flex-wrap items-baseline gap-x-3 gap-y-0.5 py-1">
                          <button type="button" className={cn(nameButton, "mr-auto")} onClick={(e) => onOpen(f.name, e.currentTarget, `g${f.id}`)} title="Open this fact">{f.name}</button>
                          <span className="shrink-0 text-caption tabular-nums text-faint">{plural(f.tokens, "token")}</span>
                          <Named g={f} />
                        </li>
                        {under(`g${f.id}`)}
                      </Fragment>
                    ))}
                  </ul>
                </div>
              </li>
            );
          })}
        </ol>
      )}
      {r && (parts.length > 1 || r.more) && (
        <Pager testid="memory-given-pager" from={(parts.length - 1) * GIVEN_PART + 1} to={(parts.length - 1) * GIVEN_PART + r.rows.length} of={r.total}
          onNewer={parts.length > 1 ? () => setParts(parts.slice(0, -1)) : undefined} onOlder={r.more ? () => setParts([...parts, r.rows.at(-1)!.id]) : undefined} />
      )}
      <p className="max-w-[46rem] text-caption text-faint">Named: {ROUGH.charAt(0).toLowerCase() + ROUGH.slice(1)}</p>
    </div>
  );
}

// The store's own search: its order, its score, nothing ranked again here.
export function SearchView({ session, onOpen, under }: { session: string; onOpen: OpenFact; under: Under }) {
  const [q, setQ] = useState("");
  const [inbox, setInbox] = useState(false);
  const [busy, setBusy] = useState(false);
  const [r, setR] = useState<{ state: State; error?: string; ms: number; hits: Hit[]; q: string } | null>(null);
  const seq = useRef(0);
  const run = (text = q, notes = inbox) => {
    if (!text.trim()) return;
    const n = ++seq.current;
    setBusy(true);
    api<{ state: State; error?: string; ms: number; hits: Hit[] }>(`/api/memory/search?q=${encodeURIComponent(text)}${session ? `&session_id=${session}` : ""}${notes ? "&inbox=1" : ""}`)
      .then((x) => { if (seq.current === n) setR({ ...x, q: text.trim() }); })
      .catch((e) => { if (seq.current === n) setR({ state: "failed", error: (e as Error).message, ms: 0, hits: [], q: text.trim() }); })
      .finally(() => { if (seq.current === n) setBusy(false); });
  };
  // Three figures of the store's score: the whole number is in the tooltip.
  const score = (s: number) => String(Number(s.toPrecision(3)));
  return (
    <div className="flex flex-col gap-3" data-testid="memory-search">
      <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); run(); }}>
        <label className="flex h-8 min-w-48 flex-1 items-center gap-2 rounded-md border border-line-strong bg-raised px-2.5 focus-within:border-accent">
          <Search className="size-3.5 shrink-0 text-faint" />
          <input data-testid="memory-search-input" aria-label="Search the memory store" value={q} maxLength={1000} onChange={(e) => setQ(e.target.value)} placeholder="Search what the store holds" className="min-w-0 flex-1 bg-transparent text-ui outline-none placeholder:text-faint" />
        </label>
        <button type="submit" disabled={busy || !q.trim()} data-testid="memory-search-go" className="h-8 rounded-md bg-accent px-3 text-ui font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-50">{busy ? "Searching" : "Search"}</button>
        <label className="flex items-center gap-2 text-caption text-muted">
          <Switch.Root checked={inbox} onCheckedChange={(v) => { setInbox(v); if (r) run(q, v); }} aria-label="Include unreviewed notes" data-testid="memory-search-inbox" className="k-switch"><Switch.Thumb className="k-switch-thumb" /></Switch.Root>
          Unreviewed notes too
        </label>
      </form>
      {!r ? <p className="k-empty">The store searches by its own ranking. A result opens the fact with its source and date.</p>
        : r.state !== "ok" ? <Trouble state={r.state as Exclude<State, "ok">} error={r.error} onRetry={() => run()} />
        : !r.hits.length ? <p className="k-empty" data-testid="memory-search-none">The store found nothing for "{r.q}".</p> : (
          <>
            <p className="text-caption text-faint" data-testid="memory-search-count">{plural(r.hits.length, "result")} in the store's own order, with its score ({r.ms} ms).</p>
            <ol className="-mx-1 flex flex-col">
              {r.hits.map((h, i) => (
                <Fragment key={h.path || h.name}>
                  <li data-testid="memory-hit" data-row="" data-name={h.name} className="grid scroll-mt-32 grid-cols-[1.5rem_minmax(0,1fr)_auto] items-baseline gap-x-2 gap-y-0.5 border-b border-line/60 px-1 py-2 last:border-0">
                    <span className="text-caption tabular-nums text-faint">{i + 1}</span>
                    <button type="button" className={nameButton} onClick={(e) => onOpen(h.name, e.currentTarget, `s${i}`)} title="Open this fact">{h.name}</button>
                    <span className="text-caption tabular-nums text-muted" title={h.score === null ? undefined : `The store's score: ${h.score}`} data-testid="memory-hit-score">{h.score === null ? "no score" : `score ${score(h.score)}`}</span>
                    <span className="col-start-2 col-end-4 text-ui text-fg [overflow-wrap:anywhere]" data-testid="memory-hit-text"><Shown text={h.description} />{h.cut ? <span className="text-faint" title="The fact opens whole"> …</span> : null}</span>
                    <span className="col-start-2 col-end-4 text-caption text-faint [overflow-wrap:anywhere]">
                      <Shown text={[h.type.replace(/_/g, " "), h.scope, h.created, h.ruling ? "the owner's ruling" : "", h.inbox ? "unreviewed note" : ""].filter(Boolean).join(", ")} />
                    </span>
                  </li>
                  {under(`s${i}`)}
                </Fragment>
              ))}
            </ol>
          </>
        )}
    </div>
  );
}

// What became of a rule where it was given: followed, broken, or no call to judge it by.
const ruleWords = (f: FactRow): string => {
  const judged = f.followed + f.broken;
  if (!judged) return "a rule that names no call to judge";
  return `followed ${f.followed} of ${judged}${f.broken ? `, broken ${f.broken}` : ""}`;
};

// One list of facts, a part at a time: each with a bar for how often it was given, against the most given of the list.
function FactList({ facts, id, onOpen, under, testid }: { facts: FactRow[]; id: string; onOpen: OpenFact; under: Under; testid: string }) {
  const [from, setFrom] = useState(0);
  useEffect(() => { setFrom(0); }, [facts.length]);
  const most = Math.max(1, ...facts.map((f) => f.given));
  const shown = facts.slice(from, from + PART);
  return (
    <>
      <ul className="flex max-w-[64rem] flex-col" data-testid={testid}>
        {shown.map((f) => (
          <Fragment key={f.name}>
            <li data-testid="memory-fact-row" data-row="" data-name={f.name} data-unused={!f.rule && f.checked > 0 && f.used === 0 ? "" : undefined}
              className="grid scroll-mt-32 grid-cols-1 items-baseline gap-x-4 gap-y-1 border-b border-line/60 py-2 last:border-0 @3xl:grid-cols-[minmax(0,1fr)_minmax(0,17rem)_6.5rem]">
              <button type="button" className={cn(nameButton, "justify-self-start")} onClick={(e) => onOpen(f.name, e.currentTarget, `${id}${f.name}`)} title="Open this fact">{f.name}</button>
              <div className="min-w-0">
                {/* How often it was given, against the most given fact of this list; the part of it that was named is filled. */}
                <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-sunken" aria-hidden>
                  <div className="h-full rounded-full bg-line-strong" style={{ width: `${Math.max(2, (100 * f.given) / most)}%` }}>
                    {(f.rule ? f.followed : f.used) > 0 && <div className="h-full rounded-full bg-ok" style={{ width: `${(100 * (f.rule ? f.followed : f.used)) / f.given}%` }} />}
                  </div>
                </div>
                <div className="mt-1 text-caption text-muted" data-testid="memory-fact-used">
                  given {f.given === 1 ? "once" : `${f.given} times`}{f.sessions > 1 ? ` in ${f.sessions} sessions` : ""}, {f.rule ? ruleWords(f) : f.checked ? (f.used ? `named after ${f.used} of ${f.checked}` : "never named after") : "not checked yet"}
                </div>
              </div>
              <div className="text-caption tabular-nums text-faint @3xl:text-right" title={`Last given ${when(f.last)}`}>{plural(f.tokens, "token")}<span className="@3xl:hidden">, last given {when(f.last)}</span></div>
            </li>
            {under(`${id}${f.name}`)}
          </Fragment>
        ))}
      </ul>
      <Pager from={from + 1} to={from + shown.length} of={facts.length} words={["Previous", "Next"]}
        onNewer={from > 0 ? () => setFrom(Math.max(0, from - PART)) : undefined} onOlder={from + PART < facts.length ? () => setFrom(from + PART) : undefined} />
    </>
  );
}

// How well what is given is used: the facts given and never named first.
export function UnusedView({ since, session, sessions, onSession, onOpen, onGone, under }: { since: number; session: string; sessions: MemorySession[]; onSession: (id: string) => void; onOpen: OpenFact; onGone: () => void; under: Under }) {
  const [r, setR] = useState<Efficiency | null>(null);
  useEffect(() => {
    let live = true;
    api<Efficiency>(`/api/memory/efficiency?since_ms=${since}${session ? `&session_id=${session}` : ""}`).then((x) => live && setR(x)).catch((e) => (gone(e) ? live && onGone() : reportError(e)));
    return () => { live = false; };
  }, [since, session]);
  const c = r?.calls;
  const unused = r?.facts.filter((f) => !f.rule && f.checked > 0 && f.used === 0) ?? [];
  const rules = r?.facts.filter((f) => f.rule) ?? [];
  const rest = r?.facts.filter((f) => !f.rule && !(f.checked > 0 && f.used === 0)) ?? [];
  const k = r?.kinds;
  return (
    <div className="@container flex flex-col gap-5" data-testid="memory-unused">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <SessionPick sessions={sessions} value={session} onChange={onSession} all />
        <span className="text-caption text-faint">in the range chosen above</span>
      </div>
      {!r || !c ? <p className="text-caption text-faint">Reading what memory cost</p> : (
        <>
          {!r.available && <p className="text-caption text-muted" data-testid="memory-absent">{ABSENT}</p>}
          <section>
            <h4 className="text-ui font-medium" data-testid="memory-unused-title">Notes given, never named afterwards (rough){unused.length ? <span className="font-normal text-faint">, {plural(unused.length, "fact")}, the most given first</span> : null}</h4>
            <p className="mb-1 mt-0.5 max-w-[46rem] text-caption text-muted" data-testid="memory-unused-caveat">{ROUGH}</p>
            {unused.length ? <FactList facts={unused} id="u" onOpen={onOpen} under={under} testid="memory-unused-list" />
              : <p className="k-empty mt-2" data-testid="memory-unused-none">{r.facts.length ? "Every fact given in this range was named at least once afterwards." : "Nothing was given in this range."}</p>}
          </section>
          {k && k.rule_rows > 0 && (
            <section data-testid="memory-rules">
              <h4 className="text-ui font-medium">Rules, followed or broken<span className="font-normal text-faint">, {plural(k.rules, "rule")}</span></h4>
              <p className="mb-1 mt-0.5 max-w-[46rem] text-caption text-muted" data-testid="memory-rules-caveat">{RULES}</p>
              <p className="mb-1 text-ui text-fg" data-testid="memory-rules-total">
                {k.followed} followed, {k.broken} broken<span className="text-muted">, {k.unjudged} given with no call to judge them by</span>
              </p>
              <FactList facts={rules} id="r" onOpen={onOpen} under={under} testid="memory-rules-list" />
            </section>
          )}
          {rest.length > 0 && (
            <section>
              <h4 className="text-ui font-medium">Notes named at least once, or not checked yet</h4>
              <FactList facts={rest} id="n" onOpen={onOpen} under={under} testid="memory-used-list" />
            </section>
          )}
          {r.total_facts > r.facts.length && <p className="text-caption text-faint" data-testid="memory-facts-more">These are {r.facts.length} of the {r.total_facts} facts given in this range: the never named first, then the most given.</p>}
          {/* The list is what the view is for; what memory cost in the range follows it. */}
          <section>
            <h4 className="mb-1.5 text-ui font-medium">What memory cost</h4>
            <Stats testid="memory-stats">
              <Stat label="Added to the context" value={`${fmtTokens(c.tokens)} tokens`} sub={`${plural(c.added, "block")} from ${plural(c.asked, "call")} of the store`} />
              <Stat label="Answered late" value={pct(c.late, c.asked)} sub={`${c.late} of ${plural(c.asked, "call")}: the turn went on without it`} />
              <Stat label="Had nothing to add" value={pct(c.empty + c.repeat, c.asked)} sub={`${c.empty} empty, ${c.repeat} already in the context`} />
              <Stat label="Failed" value={pct(c.failed, c.asked)} sub={`${c.failed} of ${plural(c.asked, "call")}`} />
            </Stats>
          </section>
          <div className="grid gap-x-8 gap-y-5 @3xl:grid-cols-2">
            <section data-testid="memory-days">
              <h4 className="mb-1.5 text-ui font-medium">Tokens per day</h4>
              {r.days.length ? (
                <ul className="flex flex-col text-caption">
                  {r.days.map((d) => <li key={d.day} className="flex items-baseline gap-3 border-b border-line/60 py-1 last:border-0"><span className="tabular-nums text-muted">{d.day}</span><span className="ml-auto tabular-nums text-faint">{plural(d.recalls, "block")}, {plural(d.sessions, "session")}</span><span className="w-16 text-right tabular-nums text-fg">{fmtTokens(d.tokens)}</span></li>)}
                </ul>
              ) : <p className="k-empty">No day in this range.</p>}
            </section>
            <section data-testid="memory-per-session">
              <h4 className="mb-1.5 text-ui font-medium">Tokens per session</h4>
              {r.sessions.length ? (
                <ul className="flex flex-col text-caption">
                  {r.sessions.map((s) => <li key={s.session_id} className="flex items-baseline gap-3 border-b border-line/60 py-1 last:border-0"><span className={cn("min-w-0 truncate", s.gone ? "text-faint" : "text-muted")} title={titleOf(s)}>{titleOf(s)}</span><span className="ml-auto shrink-0 tabular-nums text-faint">{plural(s.facts, "fact")}, {plural(s.recalls, "block")}</span><span className="w-16 shrink-0 text-right tabular-nums text-fg">{fmtTokens(s.tokens)}</span></li>)}
                </ul>
              ) : <p className="k-empty">No session in this range.</p>}
            </section>
          </div>
          <p className="text-caption text-faint">Tokens are what the memory blocks added to the context, their frames included.</p>
        </>
      )}
    </div>
  );
}

// One fact, read from the store now, and what the owner can do about it. It
// takes the keyboard when it opens, without moving the page, and gives it
// back on Escape or its close.
// `onRead`: told when the fact's text is in (it is taller then: on a phone its row is put back at the top of the view).
export function FactReader({ name, session, onClose, onOpen, onRead }: { name: string; session: string; onClose: () => void; onOpen: (name: string) => void; onRead?: () => void }) {
  const [r, setR] = useState<FactAnswer | null>(null);
  const [text, setText] = useState("");
  // `ok`: sent; false: the store did not take it; null: nothing was tried (the owner had moved on).
  const [sent, setSent] = useState<{ ok: boolean | null; line: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
  const box = useRef<HTMLElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const scope = session ? `&session_id=${session}` : "";
  useEffect(() => {
    let live = true;
    setR(null);
    setSent(null);
    setText("");
    api<FactAnswer>(`/api/memory/fact?name=${encodeURIComponent(name)}${scope}`).then((x) => live && setR(x)).catch((e) => live && setR({ state: "failed", error: (e as Error).message, correct: { note: "" }, page: { command: "", words: [], note: "" } }));
    box.current?.focus({ preventScroll: true });
    return () => { live = false; };
  }, [name, scope, tick]);

  const send = async () => {
    if (busy || !text.trim()) return;
    const post = (body: object) => api<{ state: State | "confirm"; error?: string; id?: string; words?: string[]; note?: string; writer?: string; where?: string; no_writer?: string }>("/api/memory/correct", { method: "POST", body: JSON.stringify(body) });
    const trouble = (s: string, error?: string) => `${TROUBLE[s as Exclude<State, "ok">] ?? "The store did not take it."}${error ? ` It said: ${error.slice(0, 300)}` : ""}`;
    // The owner going on to something else while the store answers: a focus or a press that lands outside this form.
    // (Where focus stands is no sign: a pointer press on a button does not focus it in every browser.)
    let away = false;
    const left = (e: Event) => { if (!form.current?.contains(e.target as Node)) away = true; };
    document.addEventListener("focusin", left, true);
    document.addEventListener("pointerdown", left, true);
    setBusy(true);
    setSent(null);
    try {
      // First the command as the store will get it. Nothing is sent by this request.
      const ask = await post({ name, text: text.trim(), ...(session ? { session_id: session } : {}) });
      if (ask.state !== "confirm" || !ask.id) return setSent({ ok: false, line: trouble(ask.state, ask.error) });
      // The question is asked only of an owner who is still at this form: one
      // who went on to something else meanwhile gets no dialog under their hands.
      if (away) return setSent({ ok: null, line: "Not sent: you had moved on before the store answered. Send it again from here to confirm it." });
      const ok = await confirmAction({
        title: "Send this correction to the memory store?", body: "Keel runs the store's own command:", code: ask.words, after: [ask.writer ?? "", ask.note ?? ""].filter(Boolean),
        action: "Send correction", careful: true,
      });
      if (!ok) return;
      const done = await post({ confirm: ask.id });
      if (done.state === "ok") { setSent({ ok: true, line: `Sent to the store${done.where ? `: ${done.where}` : ""}. It is listed in ${session ? "this session's" : "the"} activity.` }); setText(""); }
      else if (done.no_writer) setSent({ ok: false, line: `Not sent: the store has no writer named ${done.no_writer}. Settings, Memory and supervisor, names the writer corrections are recorded under.` });
      else setSent({ ok: false, line: trouble(done.state, done.error) });
    } catch (e) {
      setSent({ ok: false, line: `Not sent: ${(e as Error).message}` });
    } finally {
      document.removeEventListener("focusin", left, true);
      document.removeEventListener("pointerdown", left, true);
      setBusy(false);
    }
  };

  useEffect(() => { if (r) onRead?.(); }, [r]);
  const f = r?.fact;
  const meta: [string, ReactNode][] = f ? [
    ["Type", f.meta.type?.replace(/_/g, " ")], ["Scope", f.meta.scope], ["Kind", f.meta["source.kind"]],
    ["Writer", [f.meta["source.harness"], f.meta["source.host"]].filter(Boolean).join("@") || undefined],
    ["Created", f.meta.created], ["Last checked", f.meta.last_checked],
    ["Replaced by", f.replaced_by ? <button type="button" className={nameButton} onClick={() => onOpen(f.replaced_by!)} data-testid="memory-fact-replaced">{f.replaced_by}</button> : undefined],
  ] : [];
  const str = (v: ReactNode) => (typeof v === "string" ? <Shown text={v} /> : v);
  return (
    <aside ref={box} tabIndex={-1} onKeyDown={(e) => { if (e.key === "Escape" && !e.defaultPrevented) { e.stopPropagation(); onClose(); } }}
      className="flex min-w-0 flex-col rounded-lg border border-line-strong bg-raised outline-none focus-visible:border-accent" data-testid="memory-fact" data-name={name} aria-label={`Fact ${name}`}>
      <div className="flex items-start gap-2 border-b border-line py-1.5 pl-3 pr-1.5">
        <h4 className="min-w-0 flex-1 self-center font-mono text-ui font-semibold [overflow-wrap:anywhere]">{name}</h4>
        <button type="button" onClick={onClose} aria-label="Close the fact" title="Close (Esc)" data-testid="memory-fact-close" className="grid size-8 shrink-0 place-items-center rounded-md text-faint hover:bg-hover hover:text-fg"><X className="size-4" /></button>
      </div>
      <div className="flex flex-col px-3 pb-1 pt-2.5">
        {!r ? <p className="pb-2 text-caption text-faint">Reading it from the store</p>
          : !f ? <div className="pb-2"><Trouble state={(r.state === "ok" ? "failed" : r.state) as Exclude<State, "ok">} error={r.error} onRetry={() => setTick((n) => n + 1)} /></div> : (
            <>
              {f.head.map((h) => <p key={h} className="text-caption text-muted [overflow-wrap:anywhere]" data-testid="memory-fact-whose"><Shown text={h} /></p>)}
              <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-caption" data-testid="memory-fact-meta">
                {meta.filter(([, v]) => v).map(([k, v]) => [<dt key={k} className="text-faint">{k}</dt>, <dd key={`${k}-v`} className="min-w-0 text-fg [overflow-wrap:anywhere]">{str(v)}</dd>])}
              </dl>
              {f.meta.description && f.meta.description !== f.body && <p className="mt-2.5 text-ui font-medium text-fg [overflow-wrap:anywhere]" data-testid="memory-fact-description"><Shown text={f.meta.description} /></p>}
              <p className="mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap pb-2.5 text-ui text-fg [overflow-wrap:anywhere]" data-testid="memory-fact-body"><Shown text={f.body || f.meta.description || ""} lines /></p>
              <div className="border-t border-line py-2.5" data-testid="memory-action-correct">
                <div className="text-ui font-medium">Mark it wrong</div>
                <p className="mt-0.5 text-caption text-muted">{r.correct.note}</p>
                <form ref={form} className="mt-1.5 flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); void send(); }}>
                  <input data-testid="memory-correct-text" aria-label="What is right instead" value={text} maxLength={200} onChange={(e) => setText(e.target.value)} placeholder="What is right instead, in one line"
                    className="k-field min-w-40 flex-1" />
                  <button type="submit" disabled={!text.trim()} aria-busy={busy || undefined} data-testid="memory-correct-send" className={cn("k-btn k-btn-lg", busy && "opacity-60")}>{busy ? "Asking the store" : "Send correction"}</button>
                </form>
                {sent && <p className={cn("mt-1.5 text-caption [overflow-wrap:anywhere]", sent.ok ? "text-ok" : sent.ok === null ? "text-muted" : "text-danger")} role="status" data-testid="memory-correct-result"><Shown text={sent.line} /></p>}
              </div>
              <div className="border-t border-line py-2.5" data-testid="memory-action-page">
                <div className="text-ui font-medium">Edit or remove it</div>
                <p className="mt-0.5 text-caption text-muted">{r.page.note}</p>
                <div className="mt-1.5 flex items-start gap-2 rounded-md border border-line bg-sunken py-1 pl-2.5 pr-1">
                  <CommandWords words={r.page.words} className="min-w-0 flex-1 self-center" />
                  <CopyButton text={r.page.command} label="Copy the command" testid="memory-copy-page" />
                </div>
              </div>
            </>
          )}
      </div>
    </aside>
  );
}
