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
// Where a row's facts come from is one function (`useFact`): today what the
// page already holds (the approval, the live status, the inbox, events of a
// session that was opened; the home screen reads no transcript). When the
// daemon serves each session's state, that function is the one place to read
// it from.
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
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import type { Session } from "../../../src/core/types.ts";
import { plainLine } from "../../../src/core/plain.ts";
import { READ_MS, SETTLE_MS, settled, stand, type Stand } from "../lib/approvals.ts";
import { focusApproval, useAuto, type Alert } from "../lib/automation.ts";
import { needs, pickRows, rowKind, say, sayMore, unseenFailures, watchSummary, wholeCommand } from "../lib/home.ts";
import { getSafety, safety, useSafety, type Approval } from "../lib/safety.ts";
import { useSecrets } from "../lib/secrets.ts";
import { unsentOf } from "../lib/send-drafts.ts";
import { actions, getState, reportError, useStore } from "../lib/store.ts";
import { navigate } from "../lib/ui.ts";
import { look, usePlans } from "../lib/waits.ts";
import { ago, cn, when } from "../lib/utils.ts";
import { lastLine, type Watch } from "../lib/watch.ts";
import { usePress } from "./ApprovalCard.tsx";
import { Mark, folderOf, useLive } from "./Mark.tsx";

const FAILS = new Set<Alert["kind"]>(["failed", "limit", "loop_failed"]);
const MOST = { attention: 6, working: 4 };

// The request of one of a session's agents that waits, if any: it is answered on the session's own page.
function agentAsk(id: string, sessions: Record<string, Session>, approvals: Record<string, Approval[]>): Approval | undefined {
  for (const [sid, list] of Object.entries(approvals)) {
    if (sid === id || !list.length) continue;
    for (let s = sessions[sid], hops = 0; s?.parent_id && hops < 8; s = sessions[s.parent_id], hops++) if (s.parent_id === id) return list[0];
  }
  return undefined;
}

// Opens a session from the home screen. With a request waiting there, the card is asked for its
// list of requests, never for an answer: whatever the owner pressed here showed the request in
// short, or not at all. Every way from this screen to a session goes through here.
export function openWaiting(id: string) {
  const { sessions } = getState(), { approvals } = getSafety();
  const first = approvals[id]?.[0] ?? agentAsk(id, sessions, approvals);
  navigate({ name: "session", id });
  if (first) focusApproval(first.id, "card");
}

export function useHome() {
  const { ranked, watches } = useLive();
  const sessions = useStore((x) => x.sessions);
  const approvals = useSafety((x) => x.approvals);
  const plans = usePlans((x) => x.plans);
  const asks = useSecrets((x) => x.requests);
  // A turn that waits on a plan or a secret reads as at work: what waits in those sessions is asked for once.
  const atWork = ranked.filter((s) => !s.parent_id && s.phase === "working").map((s) => s.id).join();
  useEffect(() => { if (atWork) look(atWork.split(",")); }, [atWork]);
  return useMemo(() => {
    const own = ranked.filter((s) => !s.parent_id);
    const w = Object.fromEntries(own.map((s) => [s.id, needs(watches[s.id]!, { plan: !!plans[s.id]?.length, secret: !!asks[s.id]?.length, agent: !!agentAsk(s.id, sessions, approvals) })])) as Record<string, Watch>;
    // Where the watch says a session is at work and something waits in it, it stands with the ones that need the owner.
    const sum = watchSummary(own.map((s) => ({ id: s.id, w: w[s.id]! })), unseenFailures(own, w));
    return { ...sum, all: own, byId: Object.fromEntries(own.map((s) => [s.id, s])) as Record<string, Session>, watches: w };
  }, [ranked, watches, sessions, approvals, plans, asks]);
}

// The headline: each state with sessions in it, as a count that opens the
// first of them. With nothing to say, it says so in as many words.
export function WatchHeadline() {
  const { head, all, byId } = useHome();
  const loaded = useStore((s) => s.loaded.sessions);
  if (!head.length) {
    return (
      <h1 className="k-home-state" data-testid="home-watch" data-quiet>
        {!loaded || !all.length ? "What should we work on?" : "Nothing needs you"}
      </h1>
    );
  }
  return (
    <h1 className="k-home-state" data-testid="home-watch">
      {head.map((p) => (
        <button key={p.w} type="button" className="k-home-count" data-watch={p.w} data-testid={`home-count-${p.w}`} title={`Open ${byId[p.ids[0]!]?.title || "the session"}`} onClick={() => openWaiting(p.ids[0]!)}>
          <Mark w={p.w} />{say(p.w, p.ids.length)}
        </button>
      ))}
    </h1>
  );
}

// What one row says, and what its answer is about. The one place a row's facts are read.
// `agent`: the request is one of the session's agents' (its card is on the session's page).
type Fact = { approval?: Approval; agent?: boolean; kind: string; line: string; whole: string | null; risk?: string };
function useFact(s: Session, w: Watch): Fact {
  const own = useSafety((x) => x.approvals[s.id]?.[0]);
  const all = useSafety((x) => x.approvals);
  const sessions = useStore((x) => x.sessions);
  const theirs = useMemo(() => (own ? undefined : agentAsk(s.id, sessions, all)), [own, s.id, sessions, all]);
  const approval = own ?? theirs;
  const plan = usePlans((x) => x.plans[s.id]?.[0]);
  const secret = useSecrets((x) => x.requests[s.id]?.[0]);
  const asking = useStore((x) => !!(x.questionCalls[s.id]?.length || x.questionChildren[s.id]?.length));
  const events = useStore((x) => x.events[s.id]);
  const status = useStore((x) => x.status[s.id]);
  const alert = useAuto((x) => x.alerts.find((a) => a.session_id === s.id && (w === "need" ? a.kind === "question" : w === "fail" && FAILS.has(a.kind))));
  // An agent's request is read on its card: only the session's own command is answered from a row.
  const whole = w === "need" && own ? wholeCommand(own) : null;
  // One line of what it waits for or is doing. A question reads the same on every device: its
  // own words from the inbox, never a line that depends on whether this page loaded the session.
  const line = w === "need"
    ? (approval ? `${approval.kind === "shell" ? "" : `${approval.tool}: `}${approval.summary}`
      : plan ? plan.title || plainLine(plan.plan)
      : secret ? `The model asks for ${secret.name}${secret.purpose ? `: ${secret.purpose}` : ""}`
      : asking ? (alert ? plainLine(alert.body) : "") : unsentOf(s.id) ? "A message you wrote here was not sent." : events ? lastLine(events, s.workspace) : "")
    : w === "work" && status && status.kind !== "idle"
    ? (status.kind === "tool" ? `Running ${status.names.join(", ")}` : status.kind === "compacting" ? "Compacting the context" : status.kind === "retry" ? `Trying again: ${status.message}` : "Waiting on the model")
    : events ? lastLine(events, s.workspace) : alert ? alert.body.split("\n")[0]!.trim() : "";
  return {
    approval: w === "need" ? approval : undefined, agent: w === "need" && !!theirs,
    kind: rowKind(w, { approval, agent: !!theirs, asking, plan: !!plan, secret: !!secret }), line, whole,
    risk: w === "need" && approval?.risk === "high" ? (approval.why ? `High risk: ${approval.why}` : "High risk") : undefined,
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

function Row({ s, w, lead, stands }: { s: Session; w: Watch; lead: boolean; stands: Stands }) {
  const f = useFact(s, w);
  const a = f.approval;
  const [busy, setBusy] = useState(false);
  // What the row says back: why a press did nothing, or what the daemon said to an answer.
  const [note, setNote] = useState<{ text: string; review?: boolean } | null>(null);
  // It is about one approval: the next one starts clean.
  useEffect(() => setNote(null), [a?.id]);
  useEffect(() => { if (!note || note.review) return; const t = setTimeout(() => setNote(null), 4000); return () => clearTimeout(t); }, [note]);
  // The card is where a request is read: the keyboard lands on the list of requests, on no answer.
  const open = () => openWaiting(s.id);
  const deny = () => { navigate({ name: "session", id: s.id }); if (a) focusApproval(a.id, "deny"); };
  const notYet = () => setNote({ text: "Not yet: it moved or arrived a moment ago. Press again." });
  const allow = async () => {
    if (!a || busy) return;
    setBusy(true);
    setNote(null);
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
    <div className="k-home-row" data-testid="home-session" data-watch={w} data-session={s.id}>
      <button type="button" className="k-home-row-main" data-testid="home-open" onClick={open}>
        <span className="k-home-row-mark"><Mark w={w} /></span>
        <span dir="auto" className="k-home-row-title">{s.title || "New session"}</span>
        <span className="k-home-row-meta"><span className="k-pane-empty-in">{folderOf(s)}</span><span className="k-pane-empty-time tabular-nums" title={when(s.updated)}>{ago(s.updated)}</span></span>
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
          {w === "need" && !here && <Held id={`${s.id}:${a?.id ?? f.kind}:review`} stands={stands} lead={lead} testid="home-review" onAct={open} onRefused={notYet}>{a || f.kind === "Plan" ? "Review" : f.kind === "Question" ? "Answer" : "Open"}</Held>}
          {w === "resume" && <Held id={`${s.id}:resume`} stands={stands} lead={lead} testid="home-resume" onAct={() => void actions.resume(s.id).catch(reportError)} onRefused={notYet}>Resume</Held>}
          {w === "fail" && <Held id={`${s.id}:open`} stands={stands} lead={lead} testid="home-see" onAct={open} onRefused={notYet}>Open</Held>}
        </span>
      </div>
      {a?.notice && <p className="k-home-row-note" data-testid="home-notice">{a.notice}</p>}
      {note && <p className="k-home-row-note" role="status" data-testid="home-note">{note.text}</p>}
    </div>
  );
}

function List({ title, rows, most, testid, className }: { title: string; rows: { id: string; w: Watch }[]; most: number; testid: string; className?: string }) {
  const { byId } = useHome();
  const root = useRef<HTMLElement>(null);
  const stands = useStands(root);
  const { shown, more } = useMemo(() => pickRows(rows, most), [rows, most]);
  if (!rows.length) return null;
  const next = more[0]?.ids[0];
  return (
    <section ref={root} className={className} data-testid={testid}>
      <h2 className="k-pane-empty-word">{title}</h2>
      <div className="k-home-list">
        {shown.map((r, i) => byId[r.id] && <Row key={r.id} s={byId[r.id]!} w={r.w} lead={i === 0} stands={stands} />)}
      </div>
      {/* What did not fit, in the headline's own words, so the two counts read as one. */}
      {next && <button type="button" className="k-home-more" data-testid="home-more" onClick={() => openWaiting(next)}>{sayMore(more)}</button>}
    </section>
  );
}

// What needs the owner. On a phone, which has no rail beside the page, the
// sessions at work are listed too.
export function WatchLists({ className }: { className?: string }) {
  const { attention, working } = useHome();
  if (!attention.length && !working.length) return null;
  return (
    <div className={className} data-testid="home-lists">
      <List title="Needs you" rows={attention} most={MOST.attention} testid="home-attention" className="k-home-sec" />
      <List title="Working" rows={working} most={MOST.working} testid="home-working" className="k-home-sec md:hidden" />
    </div>
  );
}

// The ids the attention rows show, so the recent list does not repeat them.
export function useAttended(): Set<string> {
  const { attention } = useHome();
  return useMemo(() => new Set(pickRows(attention, MOST.attention).shown.map((r) => r.id)), [attention]);
}
