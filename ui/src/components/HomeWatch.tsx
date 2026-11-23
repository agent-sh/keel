// The home screen's watch over every session, in the state language the rest
// of the page speaks (one mark, one color, one word a state). It tells two
// things in five seconds: what needs the owner now, and where to start.
//
// The headline is the sessions' state as counts. The rows beside or under the
// start box are the sessions that need the owner: the session's title, what
// kind of thing waits (a command, a question, a failure) and what it is, in
// full where the owner is to answer it here. A failed session is news until
// some device has shown it or its next turn started; after that it is a
// failed session in the list. A state the headline counts always has a row.
//
// What a session needs, why, and in whose session it waits is the state the
// daemon serves (lib/watch.ts): the headline counts it, a row's kind comes
// from its reason and a row's line is its text. The page adds only the card
// of an approval it holds, to show a command whole and say its kind and risk.
// The home screen reads no transcript.
//
// An approval is given from a row only for what the owner could read, by a
// press they meant, as on the approval card (lib/approvals.ts):
// - "Allow once" is offered only for a command the row shows whole (lib/home.ts).
//   Anything else is reviewed on its card.
// - Every way from here to a session with a request waiting (the row's title,
//   its Review, a count in the headline, the line under the rows) goes through
//   one helper (`openWaiting`), which asks the card for its list of requests,
//   never for an answer.
// - The buttons belong to one approval (keyed by its id), so neither a press
//   nor the focus passes to the session's next call.
// - Every button of a row acts only after it has stood whole and still on
//   screen for the settle time, wherever the move came from (a new row, the
//   list's place on the page): one that moved under the pointer opens nothing
//   and answers nothing. A press before that is answered: the button is ringed
//   and the row says why.
// - Deny opens the card's own denial, the keyboard in its reason field.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import type { Session } from "../../../src/core/types.ts";
import { READ_MS, SETTLE_MS, settled, stand, type Stand } from "../lib/approvals.ts";
import { focusAsk } from "../lib/asks.ts";
import { focusApproval, useAuto } from "../lib/automation.ts";
import { pickRows, rowKind, rowLine, sayMore, watchSummary, wholeCommand, withAgentFailures } from "../lib/home.ts";
import { getSafety, safety, useSafety, type Approval } from "../lib/safety.ts";
import { actions, reportError, useStore } from "../lib/store.ts";
import { navigate } from "../lib/ui.ts";
import { COUNTERS, OFFLINE, STATE_WORD, asOf, countsNow } from "../../../src/core/state-words.ts";
import { ago, clock, cn, when } from "../lib/utils.ts";
import { WATCH_RANK, useSessionStates, type SessionState, type Watch } from "../lib/watch.ts";
import { usePress } from "./ApprovalCard.tsx";
import { Mark, folderOf } from "./Mark.tsx";

const MOST = { attention: 6, working: 4 };

// Opens a session from the home screen: the session itself, or the agent's
// session its first request waits in (`child`). With an approval waiting
// there, the keyboard lands on the list of requests, as by every way to a
// request (the palette opens a session through here too), and the card
// decides from there (lib/asks.ts, ApprovalCard.tsx): a text that is not all
// read (cut, in part, marked, lines never in view) keeps the keyboard off its
// answers, and one that is whole takes it on Allow once after the settle
// time, never before. So a short command needs no second look, and a key
// pressed on the way in answers nothing.
// With anything else waiting there (a question, a plan, a secret request) the
// keyboard goes to that card, as the owner's own doing (lib/asks.ts): never to
// an answer, and a secret's field takes it, since they came to give it.
// Every way from this screen to a session goes through here.
export function openWaiting(id: string, child?: string) {
  const to = child ?? id;
  const first = getSafety().approvals[to]?.[0];
  navigate({ name: "session", id: to });
  if (first) focusApproval(first.id, "allow");
  else focusAsk(to);
}

export function useHome() {
  const sessions = useStore((x) => x.sessions);
  const own = useMemo(() => Object.values(sessions).filter((s) => !s.archived && !s.parent_id), [sessions]);
  const states = useSessionStates(own);
  return useMemo(() => {
    // A session with agents that failed counts as Failed until the owner looks at it (lib/home.ts).
    const counted = withAgentFailures(own, states);
    const watches = Object.fromEntries(own.map((s) => [s.id, counted.states[s.id]!.watch])) as Record<string, Watch>;
    const ranked = [...own].sort((a, b) => WATCH_RANK[watches[a.id]!] - WATCH_RANK[watches[b.id]!] || b.updated - a.updated);
    const told = ranked.map((s) => ({ id: s.id, st: counted.states[s.id]! })), unseen = counted.unseen;
    // A session whose machine does not answer is not counted: its state is the last it told, not what it is.
    const sum = { ...watchSummary(told, unseen), head: watchSummary(told.filter((r) => countsNow(r.st)), unseen).head };
    return { ...sum, all: own, byId: Object.fromEntries(own.map((s) => [s.id, s])) as Record<string, Session>, states: counted.states };
  }, [own, states]);
}

// The headline: each state with sessions in it, as a count that opens the
// first of them. With nothing to say, it says so in as many words.
export function WatchHeadline() {
  const { head, all, byId, states } = useHome();
  const loaded = useStore((s) => s.loaded.sessions);
  if (!head.length) {
    return (
      <h1 className="k-home-state" data-testid="home-watch" data-quiet>
        {!loaded || !all.length ? "What should we work on?" : COUNTERS.calm}
      </h1>
    );
  }
  return (
    <h1 className="k-home-state" data-testid="home-watch">
      {head.map((p) => (
        <button key={p.kind} type="button" className="k-home-count" data-watch={p.w} data-testid={`home-count-${p.kind}`} title={`${p.w === "need" ? `${COUNTERS.waiting(p.n)}. ` : ""}Open ${byId[p.ids[0]!]?.title || "the session"}`} onClick={() => openWaiting(p.ids[0]!, states[p.ids[0]!]?.child)}>
          <Mark w={p.w} />{p.text}
        </button>
      ))}
    </h1>
  );
}

// What one row says, and what its answer is about: the served state, and the
// card of the approval it stands on where the page holds it (the session's
// own, or its agent's). Only the session's own command is answered from a row.
type Fact = { approval?: Approval; kind: string; line: string; whole: string | null; risk?: string };
function useFact(s: Session, st: SessionState): Fact {
  const asked = st.watch === "need" && st.why === "approval";
  const approval = useSafety((x) => (asked ? x.approvals[st.child ?? s.id]?.[0] : undefined));
  return {
    approval, kind: rowKind(st, approval?.kind), line: rowLine(st),
    whole: asked && !st.child ? wholeCommand(approval, !!s.machine) : null,
    risk: approval?.risk === "high" ? (approval.why ? `High risk: ${approval.why}` : "High risk") : undefined,
  };
}

// Where the rows' answering buttons stand on screen, read as the approval
// card reads its own: ten times a second, and at once when the page scrolls
// or changes size and as a press is made. A button may be pressed once it has
// stood whole and still for the settle time: one that just arrived, or that
// anything moved (a new row, a banner over the page), waits again.
function useStands(root: RefObject<HTMLElement | null>) {
  const stands = useRef(new Map<string, Stand>());
  const [live, setLive] = useState<ReadonlySet<string>>(new Set());
  const shown = useRef("");
  const read = useCallback(() => {
    const now = performance.now();
    const next = new Map<string, Stand>();
    const ok = new Set<string>();
    const visible = document.visibilityState === "visible";
    for (const el of root.current?.querySelectorAll<HTMLElement>("[data-hold]") ?? []) {
      const r = el.getBoundingClientRect();
      // Whole inside the window. (What something lies over cannot be pressed by a pointer at all, so that is not asked.)
      const whole = visible && r.width > 0 && r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth;
      const key = el.dataset.hold!;
      const at = stand(stands.current.get(key), { x: r.left, y: r.top, whole }, now);
      next.set(key, at);
      if (settled(at, now)) ok.add(key);
    }
    stands.current = next;
    const sig = [...ok].sort().join();
    if (sig !== shown.current) { shown.current = sig; setLive(ok); }
    return ok;
  }, [root]);
  useEffect(() => {
    read();
    const t = setInterval(read, READ_MS);
    const now = () => void read();
    addEventListener("scroll", now, true);
    addEventListener("resize", now);
    document.addEventListener("visibilitychange", now);
    return () => { clearInterval(t); removeEventListener("scroll", now, true); removeEventListener("resize", now); document.removeEventListener("visibilitychange", now); };
  }, [read]);
  // At the instant of a press: where it stands now, not at the last reading.
  return { live, armed: (key: string) => read().has(key) };
}
type Stands = ReturnType<typeof useStands>;

// A button that answers: it acts only where it has stood. Held, it stays in the tab order and says
// it is not ready (aria-disabled, not disabled); a press on it then is ringed and told to the row.
function Held({ id, stands, lead, quiet, busy, onAct, onRefused, testid, title, children }: { id: string; stands: Stands; lead?: boolean; quiet?: boolean; busy?: boolean; onAct: () => void; onRefused: () => void; testid?: string; title?: string; children: ReactNode }) {
  const live = stands.live.has(id);
  const pressed = usePress(() => stands.armed(id), (ok) => ok);
  const [nudge, setNudge] = useState(false);
  useEffect(() => { if (!nudge) return; const t = setTimeout(() => setNudge(false), SETTLE_MS); return () => clearTimeout(t); }, [nudge]);
  return (
    <button
      type="button" className={cn("k-home-act", lead && "k-home-act-lead")} data-quiet={quiet || undefined} title={title} data-hold={id} data-testid={testid} data-nudge={nudge || undefined}
      disabled={busy} aria-disabled={!live || undefined}
      onPointerDown={pressed.onPointerDown} onMouseDown={pressed.onMouseDown}
      // A key held down answers once: its repeats press nothing.
      onKeyDown={(e) => { if (e.key === "Enter" && e.repeat) e.preventDefault(); }}
      onClick={(e) => { if (pressed.said(e)) onAct(); else { setNudge(true); onRefused(); } }}
    >
      {children}
    </button>
  );
}

function Row({ s, st, lead, stands, onAnswer, room }: { s: Session; st: SessionState; lead: boolean; stands: Stands; onAnswer: () => void; room?: number }) {
  const w = st.watch;
  const f = useFact(s, st);
  const a = f.approval;
  const [busy, setBusy] = useState(false);
  // What the row says back: why a press did nothing, or what the daemon said to an answer.
  const [note, setNote] = useState<{ text: string; review?: boolean } | null>(null);
  // It is about one approval: the next one starts clean.
  useEffect(() => setNote(null), [a?.id]);
  useEffect(() => { if (!note || note.review) return; const t = setTimeout(() => setNote(null), 4000); return () => clearTimeout(t); }, [note]);
  // The card is where a request is read: the keyboard lands on the list of requests, on no answer.
  const open = () => openWaiting(s.id, st.child);
  const deny = () => { navigate({ name: "session", id: s.id }); if (a) focusApproval(a.id, "deny"); };
  // A turn a restart cut that Keel did not resume: the row resumes it.
  const held = w === "need" && st.why === "resume";
  const notYet = () => setNote({ text: "Not yet: it moved or arrived a moment ago. Press again." });
  const allow = async () => {
    if (!a || busy) return;
    setBusy(true);
    setNote(null);
    onAnswer();
    try {
      await safety.answer(s.id, a.id, { choice: "once" });
    } catch (e) {
      // The daemon would not take the answer (answered meanwhile, not answerable from here, gone): its own words, and the card to look at.
      setNote({ text: (e as Error).message || "The daemon did not take the answer.", review: true });
      if ((e as { status?: number }).status === 409) safety.loadSession(s.id).catch(reportError);
      else reportError(e, { at: "home allow" });
    } finally {
      setBusy(false);
    }
  };
  const here = w === "need" && f.whole !== null && !note?.review;
  return (
    <div className="k-home-row" data-testid="home-session" data-watch={w} data-session={s.id} style={room ? { minHeight: room } : undefined}>
      <button type="button" className="k-home-row-main" data-testid="home-open" onClick={open}>
        <span className={cn("k-home-row-mark", st.offline && "opacity-45 grayscale [&_.k-mark]:[animation-play-state:paused]")}><Mark w={w} /></span>
        <span dir="auto" className="k-home-row-title">{s.title || "New session"}</span>
        <span className="k-home-row-meta"><span className="k-pane-empty-in">{folderOf(s)}</span><span className="k-pane-empty-time tabular-nums" data-testid={st.as_of ? "home-asof" : undefined} title={st.offline ? "Its machine does not answer: this is the last it told" : when(s.updated)}>{st.as_of ? `${st.offline ? `${OFFLINE}, ` : ""}${asOf(clock(st.as_of))}` : st.offline ? OFFLINE : ago(s.updated)}</span></span>
      </button>
      <div className="k-home-row-what">
        <span className="k-home-row-word" data-testid="home-kind">{f.kind}</span>
        {f.risk && <span className="k-home-row-risk" data-testid="home-risk" title={f.risk}>high risk</span>}
        {/* A command to be allowed here is shown whole, wrapped, in the code face. Anything else is one line, read on its card. */}
        {here
          ? <code dir="ltr" className="k-home-row-cmd" data-testid="home-command">{f.whole}</code>
          : f.line && <span dir="auto" className="k-home-row-line" title={f.line}>{f.line}</span>}
        {/* The buttons belong to this one approval: its id is their key, so neither a press nor the focus passes to the next call. */}
        <span className="k-home-acts" key={a?.id ?? w}>
          {here && (
            <>
              <Held id={`${s.id}:${a!.id}`} stands={stands} lead={lead} busy={busy} testid="home-allow" onAct={() => void allow()} onRefused={notYet}>{busy ? "Allowing" : "Allow once"}</Held>
              <Held id={`${s.id}:${a!.id}:deny`} stands={stands} quiet busy={busy} testid="home-deny" title="Opens its card, where a denial takes your reason" onAct={deny} onRefused={notYet}>Deny…</Held>
            </>
          )}
          {w === "need" && !here && !held && <Held id={`${s.id}:${a?.id ?? st.why}:review`} stands={stands} lead={lead && !st.offline} quiet={st.offline} testid="home-review" onAct={open} onRefused={notYet}>{st.offline ? "Open" : st.why === "approval" || st.why === "plan" ? "Review" : st.why === "question" || st.why === "owner" ? "Answer" : "Open"}</Held>}
          {held && <Held id={`${s.id}:resume`} stands={stands} lead={lead} testid="home-resume" onAct={() => void actions.resume(s.id).catch(reportError)} onRefused={notYet}>Resume</Held>}
          {(w === "fail" || w === "declined" || w === "stop") && <Held id={`${s.id}:open`} stands={stands} lead={lead} testid="home-see" onAct={open} onRefused={notYet}>Open</Held>}
        </span>
      </div>
      {a?.notice && <p className="k-home-row-note" data-testid="home-notice">{a.notice}</p>}
      {note && <p className="k-home-row-note" role="status" data-testid="home-note">{note.text}</p>}
    </div>
  );
}

// The rows stand still under the hand: while a finger or the pointer is down on the list, and
// for the settle time after an answer and after a row it answered went, the rows keep their
// order and their places. A row that left meanwhile keeps its room, as a quiet line that says it
// was answered; one that came is put at the end. Then the list is what it is. (Without it, an
// answered row went at once, the next came up under the finger, and its Allow, having just moved,
// refused the press that followed.) With no answer of a row left in view to press, the list closes
// up at once: nothing is under the finger then, and the rows that come up start their settle time
// as early as they can.
function useStill(root: RefObject<HTMLElement | null>, live: string[]) {
  const [held, setHeld] = useState<string[] | null>(null);
  const down = useRef(false), until = useRef(0), timer = useRef(0);
  const shownNow = useRef(live);
  const heights = useRef(new Map<string, number>());
  // An answer of a row still waiting stands whole in the window (one a finger may be on its way to).
  const pressable = () => [...(root.current?.querySelectorAll<HTMLElement>('[data-testid="home-session"] [data-hold]') ?? [])].some((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth;
  });
  const release = useCallback(() => {
    window.clearTimeout(timer.current);
    const wait = until.current - performance.now();
    if (down.current) return;
    if (!pressable()) { until.current = 0; setHeld(null); return; }
    if (wait > 0) { timer.current = window.setTimeout(release, wait + 1); return; }
    setHeld(null);
  }, []);
  const hold = useCallback((ms: number) => {
    until.current = Math.max(until.current, performance.now() + ms);
    setHeld((h) => h ?? shownNow.current);
    release();
  }, [release]);
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const press = () => { down.current = true; hold(0); };
    const up = () => { if (!down.current) return; down.current = false; release(); };
    el.addEventListener("pointerdown", press, true);
    addEventListener("pointerup", up, true);
    addEventListener("pointercancel", up, true);
    return () => { el.removeEventListener("pointerdown", press, true); removeEventListener("pointerup", up, true); removeEventListener("pointercancel", up, true); window.clearTimeout(timer.current); };
  }, [root, hold, release]);
  const order = held ? [...held, ...live.filter((id) => !held.includes(id))] : live;
  shownNow.current = order;
  const gone = held ? held.filter((id) => !live.includes(id)) : [];
  // A row that went while held keeps the list still for the settle time from then.
  const goneKey = gone.join();
  useEffect(() => { if (goneKey) hold(SETTLE_MS); }, [goneKey, hold]);
  // (Read after the frame the list was drawn in: whether an answer is left in view.)
  useEffect(() => { if (held && !down.current) { const f = requestAnimationFrame(() => release()); return () => cancelAnimationFrame(f); } }, [held, goneKey, release]);
  // Each row's height as drawn before the hold (and of one that came during it, as it came): the
  // room it keeps while held, whatever it says meanwhile (an answered request leaves its row first).
  useLayoutEffect(() => {
    for (const r of root.current?.querySelectorAll<HTMLElement>('[data-testid="home-session"][data-session]') ?? []) {
      if (!held || !heights.current.has(r.dataset.session!)) heights.current.set(r.dataset.session!, r.getBoundingClientRect().height);
    }
  });
  return { order, held: !!held, gone: new Set(gone), height: (id: string) => heights.current.get(id), answered: () => hold(SETTLE_MS) };
}

function List({ title, rows, most, testid, className }: { title: string; rows: { id: string; w: Watch }[]; most: number; testid: string; className?: string }) {
  const { byId, states } = useHome();
  const root = useRef<HTMLElement>(null);
  const stands = useStands(root);
  const { shown, more } = useMemo(() => pickRows(rows, most), [rows, most]);
  const still = useStill(root, useMemo(() => shown.map((r) => r.id), [shown]));
  if (!rows.length && !still.gone.size) return null;
  const next = more[0]?.ids[0];
  return (
    <section ref={root} className={className} data-testid={testid}>
      <h2 className="k-pane-empty-word">{title}</h2>
      <div className="k-home-list">
        {still.order.map((id) => still.gone.has(id)
          ? <div key={id} className="k-home-row k-home-kept" data-testid="home-kept" data-session={id} style={{ minHeight: still.height(id) }} aria-hidden="true"><span dir="auto" className="k-home-row-title">{byId[id]?.title || "New session"}</span><span className="k-home-kept-word">Answered</span></div>
          : byId[id] && states[id] && <Row key={id} s={byId[id]!} st={states[id]!} lead={id === still.order.find((x) => !still.gone.has(x))} stands={stands} onAnswer={still.answered} room={still.held ? still.height(id) : undefined} />)}
      </div>
      {/* What did not fit, in the headline's own words, so the two counts read as one. */}
      {next && <button type="button" className="k-home-more" data-testid="home-more" onClick={() => openWaiting(next, states[next]?.child)}>{sayMore(more)}</button>}
    </section>
  );
}

// What needs the owner. On a phone, which has no rail beside the page, the
// sessions at work are listed too.
// What finished since the owner last looked: the sessions with a finish not read yet, counted, a press
// from the Inbox that lists them. With the lists, not the headline: a finish that comes moves no start box;
// under the rows that need the owner, so it moves none of those either (one answered there often finishes).
function Finished() {
  const sessions = useStore((x) => x.sessions);
  const done = useAuto((x) => [...new Set(x.alerts.filter((a) => a.kind === "finished" && !a.read && a.session_id).map((a) => a.session_id!))].join(" "));
  const n = done ? done.split(" ").filter((id) => sessions[id] && !sessions[id]!.archived).length : 0;
  if (!n) return null;
  return (
    <p className="k-home-finished" data-testid="home-finished">
      <button type="button" className="k-home-count" data-watch="done" data-testid="home-count-finished" title={`${n} ${n === 1 ? "session" : "sessions"} finished since you last looked: open the Inbox`} onClick={() => dispatchEvent(new Event("keel:inbox"))}>
        <Mark w="done" />{n} {STATE_WORD.done.toLowerCase()} since you looked
      </button>
    </p>
  );
}

export function WatchLists({ className }: { className?: string }) {
  const { attention, working } = useHome();
  const finished = useAuto((x) => x.alerts.some((a) => a.kind === "finished" && !a.read));
  if (!attention.length && !working.length && !finished) return null;
  return (
    <div className={className} data-testid="home-lists">
      <List title={STATE_WORD.need} rows={attention} most={MOST.attention} testid="home-attention" className="k-home-sec" />
      {/* Under what needs the owner: a finish that comes while they answer moves no row they are pressing. */}
      <Finished />
      <List title={working.every((r) => r.w === "work") ? STATE_WORD.work : `${STATE_WORD.work} and ${STATE_WORD.wait.toLowerCase()}`} rows={working} most={MOST.working} testid="home-working" className="k-home-sec md:hidden" />
    </div>
  );
}

// The ids the attention rows show, so the recent list does not repeat them.
export function useAttended(): Set<string> {
  const { attention } = useHome();
  return useMemo(() => new Set(pickRows(attention, MOST.attention).shown.map((r) => r.id)), [attention]);
}
