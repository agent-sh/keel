import { ClipboardList, Pencil } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { PlanCard as Card } from "../../../src/server/routes/plan.ts";
import { paintedReader, readOnSteps, sawLines, SETTLE_MS, unseenLines, type Lines, type PaintedReader } from "../lib/approvals.ts";
import { dropRepeats, keyRefused, noteAnswer, typeToBox, useAskKeys, useHold } from "../lib/asks.ts";
import { composing } from "../lib/keys.ts";
import { setOpenPlans } from "../lib/plans.ts";
import { wasBrought } from "../lib/shell.ts";
import { api, onFeature, reportUnlessGone, failed } from "../lib/store.ts";
import { cn } from "../lib/utils.ts";
import { trayGauge } from "./Composer.tsx";
import { Markdown } from "./Markdown.tsx";
import { Select } from "./Select.tsx";

const MODES = [
  { id: "ask", label: "Ask" },
  { id: "auto-edits", label: "Auto edits" },
  { id: "auto", label: "Auto" },
  { id: "reviewer", label: "Reviewer" },
  { id: "full-auto", label: "Full auto" },
];

// A plan the model presents in plan mode, above the composer: approve it (as
// it is or edited) and pick the mode the work goes on in, or say what to change.
export function PlanCards({ sessionId }: { sessionId: string }) {
  const [cards, setCards] = useState<Card[]>([]);
  useEffect(() => {
    type F = { state: "open" | "closed"; card: Card };
    const step = (l: Card[], f: F) => (f.state === "open" ? [...l.filter((c) => c.id !== f.card.id), f.card] : l.filter((c) => c.id !== f.card.id));
    // Frames that came while a load was on its way are newer than its answer: applied on top of it.
    let since: F[] | null = null;
    // A session deleted while the page was cut off answers 404: a state its station shows, no failure.
    const load = () => {
      const mine: F[] = (since = []);
      api<{ open: Card[] }>(`/api/sessions/${sessionId}/plan`).then((r) => { const open = mine.reduce(step, r.open); setOpenPlans(sessionId, open.map((c) => c.id)); setCards(open); }).catch(reportUnlessGone).finally(() => { if (since === mine) since = null; });
    };
    load();
    return onFeature({
      // A plan put back up after a daemon restart may have opened before this socket did.
      reconnect: load,
      frame: (f) => {
        if (f.name !== "plan" || f.session_id !== sessionId) return;
        since?.push(f.data);
        setCards((l) => step(l, f.data));
      },
    });
  }, [sessionId]);
  if (!cards.length) return null;
  return <div className="mb-2 flex flex-col gap-2">{cards.map((c, i) => <Plan key={c.id} c={c} first={i === 0} />)}</div>;
}

// The card is held to the one rule of lib/asks.ts. The keyboard comes to the
// plan's text, never to Approve: there the arrows and the page keys scroll it,
// and what is typed goes to the message box. Approve is one Tab away, and a key
// on it approves only a plan that was read.
//
// Read is the approval cards' rule (lib/approvals.ts), the same for a key, a
// click and a tap: every line of the plan has been in view, where words show
// (the window, the region above the message box, the plan's own box, less the
// foot that holds Approve). While the owner scrolls each painted view counts
// (the painted reader takes the reading after the frame that drew it); a view
// the page put there counts once it has stood the settle time.
// Approve stays at the card's foot while the card goes on under the region's
// edge (where that leaves the plan a third of the region), so it is in view
// without scrolling the plan; a press there before the plan was read is refused
// and says how much of it was not seen. End and
// Page Down on the text read on a step at a time, so no line is jumped over.
// A plan that stood whole in view (none of it scrolled out, nothing over it) for the settle time
// is read, and Approve then takes the keyboard by itself, as an approval's Allow once does.
function Plan({ c, first }: { c: Card; first: boolean }) {
  const [editing, setEditing] = useState(false);
  const [plan, setPlan] = useState(c.plan);
  const [mode, setMode] = useState("auto-edits");
  const [feedback, setFeedback] = useState("");
  const [back, setBack] = useState(false);
  const [err, setErr] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const text = useRef<HTMLDivElement>(null);
  const approve = useRef<HTMLButtonElement>(null);
  const foot = useRef<HTMLElement | null>(null);
  const footRef = (n: HTMLElement | null) => { foot.current = n; };
  useAskKeys(root, first);
  const hold = useHold(root);
  const [at, setAt] = useState<"" | "text" | "approve">(""); // where in the card the keyboard is
  const [read, setRead] = useState(false);
  // The lines not seen yet (`n`), those of them out of view now (`out`), and whether the plan is longer than where it shows.
  const [left, setLeft] = useState({ n: 0, out: 0, total: 1, long: false });
  const lines = useRef<Lines | undefined>(undefined);
  const handAt = useRef(0); // the owner's own hand on the plan or the region: a scroll after it is theirs
  const see = useRef((_painted: boolean) => {});
  const reading = useRef(false); // a reading on by End or Page Down is under way
  const queued = useRef(0); // presses made meanwhile, to make after it (Infinity: an End)
  const reader = useRef<PaintedReader | null>(null);
  const [fits, setFits] = useState(false); // the whole plan stands in view, none of it scrolled out or under the foot
  // Since when it has stood so (null: not now): Approve takes the keyboard only once it stood whole for the settle time.
  const fitsAt = useRef<number | null>(null);
  if (!fits) fitsAt.current = null;
  else fitsAt.current ??= performance.now();
  const [woke, wake] = useState(0);
  useEffect(() => {
    const el = text.current;
    if (!el) return;
    const tray = el.closest<HTMLElement>('[data-testid="composer-tray"]');
    // Being written by the owner is read; else what of the plan has been in view, as above.
    see.current = (painted: boolean) => {
      const r = el.getBoundingClientRect(), box = tray?.getBoundingClientRect(), f = foot.current?.getBoundingClientRect();
      // The foot stays at the region's edge where it leaves the plan a third of the region or more (a
      // shorter region scrolls it with the card). Where it lies over the text, what it covers is not in view.
      const stick = !!f && !!box && f.height > 0 && f.height * 3 <= box.height * 2;
      foot.current?.toggleAttribute("data-stick", stick);
      const stuck = stick && f!.top < r.bottom - 1 && f!.bottom > r.top;
      foot.current?.toggleAttribute("data-stuck", stuck);
      // Whole in view: its box holds all of it, and the box stands in the region, clear of the foot.
      setFits(el.scrollHeight - el.clientHeight <= 2 && r.height > 0 && !!box && r.top >= Math.max(0, box.top) - 0.5 && r.bottom <= Math.min(innerHeight, box.bottom) + 0.5 && !stuck);
      if (editing) { setRead(true); return; }
      if (read) return;
      const cs = getComputedStyle(el);
      const line = parseFloat(cs.lineHeight) || 1.5 * parseFloat(cs.fontSize) || 24;
      const padTop = parseFloat(cs.paddingTop) || 0, padBottom = parseFloat(cs.paddingBottom) || 0;
      const content = el.scrollHeight - padTop - padBottom;
      const total = Math.max(1, Math.round(content / line));
      const inner = r.top + el.clientTop;
      const top = Math.max(0, box?.top ?? 0, inner), bottom = Math.min(innerHeight, box?.bottom ?? innerHeight, inner + el.clientHeight, stuck ? f!.top : Infinity);
      const y = (v: number) => v - inner + el.scrollTop - padTop;
      const shows = r.width > 0 && bottom > top && document.visibilityState === "visible" && !el.closest("[inert]");
      // A view that reaches the plan's first or last words covers its first or last line whole.
      const view: [number, number] | null = shows ? [y(top) <= 1 ? 0 : y(top), y(bottom) >= content - 1 ? total * line : y(bottom)] : null;
      lines.current = sawLines(lines.current, { total, line, view, painted }, performance.now() - handAt.current < SETTLE_MS, performance.now());
      const u = unseenLines(lines.current);
      const long = content > bottom - top + 1;
      setLeft((was) => (was.n === u.n && was.out === u.out && was.total === total && was.long === long ? was : { n: u.n, out: u.out, total, long }));
      if (u.n === 0) setRead(true);
    };
    // Each move is read at once (where the foot stands) and again once it was painted (the lines seen).
    const painted = (reader.current = paintedReader(() => [el, ...(tray ? [tray] : [])], () => see.current(true)));
    const see_ = () => { see.current(false); painted.ask(); };
    const hand = () => { handAt.current = performance.now(); };
    see_();
    el.addEventListener("scroll", see_, { passive: true });
    tray?.addEventListener("scroll", see_, { passive: true });
    for (const ev of ["pointerdown", "wheel", "touchmove", "keydown"] as const) (tray ?? el).addEventListener(ev, hand, { capture: true, passive: true });
    const sized = new ResizeObserver(see_);
    sized.observe(el);
    if (tray) sized.observe(trayGauge(tray)!);
    // A view that stands counts after the settle time, and nothing tells when that is: read again meanwhile.
    const tick = read ? 0 : window.setInterval(see_, 200);
    return () => {
      painted.stop(); reader.current = null; reading.current = false; queued.current = 0;
      el.removeEventListener("scroll", see_); tray?.removeEventListener("scroll", see_);
      for (const ev of ["pointerdown", "wheel", "touchmove", "keydown"] as const) (tray ?? el).removeEventListener(ev, hand, { capture: true });
      sized.disconnect(); window.clearInterval(tick);
    };
  }, [editing, read]);
  // End and Page Down on the text read on through the plan a step at a time, each step under the
  // height of what shows (so two views share their lines), read as the owner's own scroll once it
  // was painted (lib/approvals.ts: readOnSteps): the plan's box first, then the region. A press
  // while one is under way waits its turn: a Page Down is one step more, an End goes on to the end.
  const readOn = (end: boolean) => {
    const el = text.current, tray = el?.closest<HTMLElement>('[data-testid="composer-tray"]');
    if (!el || !reader.current) return;
    if (reading.current) { queued.current = end ? Infinity : queued.current + 1; return; }
    const go = () => {
      const f = foot.current?.hasAttribute("data-stuck") ? foot.current.offsetHeight : 0;
      const frame = Math.min(el.clientHeight, tray ? tray.clientHeight - f : el.clientHeight);
      const step = Math.max(16, Math.round(frame * 0.6));
      handAt.current = performance.now();
      if (el.scrollTop + el.clientHeight < el.scrollHeight - 1) el.scrollTop += step;
      else if (tray && el.getBoundingClientRect().bottom > tray.getBoundingClientRect().bottom - f + 1 && tray.scrollTop + tray.clientHeight < tray.scrollHeight - 1) tray.scrollTop += step;
      else return false;
      return true;
    };
    reading.current = true;
    readOnSteps(go, reader.current, end, () => {
      reading.current = false;
      const more = queued.current;
      queued.current = 0;
      if (more > 0) { if (more !== Infinity) queued.current = more - 1; readOn(more === Infinity); }
    });
  };
  // Brought here as a thing to answer, the keyboard on the text: once the settle time has passed
  // and the plan stood whole in view, Approve takes it (once an arrival). Not for an owner
  // brought from outside the page (a link, the desktop app): there it stays where it is read.
  const moved = useRef(0);
  const comes = hold.take && moved.current !== hold.at && at === "text" && read && fits && !editing && !wasBrought();
  useEffect(() => {
    if (hold.keys !== "ready" || !hold.take || moved.current === hold.at || !read) return;
    // Whole in view for the settle time first: asked again when that time is up (it may change meanwhile).
    const wait = fits && fitsAt.current !== null ? fitsAt.current + SETTLE_MS - performance.now() : 0;
    if (wait > 0) { const t = window.setTimeout(() => wake((n) => n + 1), wait + 1); return () => window.clearTimeout(t); }
    moved.current = hold.at;
    if (document.activeElement !== text.current || !fits || editing || wasBrought() || !approve.current || approve.current.disabled) return;
    approve.current.focus({ preventScroll: true });
  }, [hold.keys, hold.take, hold.at, read, fits, fitsAt.current, woke]);
  const [nudge, setNudge] = useState("");
  useEffect(() => {
    if (!nudge) return;
    const t = window.setTimeout(() => setNudge(""), SETTLE_MS * 2);
    return () => window.clearTimeout(t);
  }, [nudge]);
  const send = (b: object) => { noteAnswer(c.id); return api(`/api/sessions/${c.session_id}/plan/${c.id}`, { method: "POST", body: JSON.stringify(b) }).catch((e) => setErr(failed(e, { at: "PlanCard" }))); };
  const hint = nudge ? nudge
    : comes ? "Enter approves the plan in a moment"
    : at === "text" ? (read ? "Tab goes to Approve" : "Read to the end, then Tab goes to Approve")
    : at === "approve" && hold.keys === "ready" ? (read ? "Enter approves the plan" : "Read the plan to its end first")
    : "";
  return (
    <div
      ref={root}
      className="animate-in overflow-clip rounded-2xl border border-accent/40 bg-raised shadow-2"
      data-testid="plan-card"
      data-ask-card=""
      data-keys={hold.keys || undefined}
      data-read={read || undefined}
      onKeyDownCapture={dropRepeats}
      onKeyDown={(e) => {
        if (composing(e) || typeToBox(e)) return;
        const on = e.target as Element;
        // From the text, Tab goes to Approve (the mode before it is one Shift Tab back); Up from Approve is back on the text.
        if (e.key === "Tab" && !e.shiftKey && on === text.current && approve.current) { e.preventDefault(); approve.current.focus(); }
        else if (e.key === "ArrowUp" && on === approve.current) { e.preventDefault(); text.current?.focus(); }
        // On the text the scrolling keys are the plan's own: End reads it to its end, not the conversation.
        else if (on === text.current && ["End", "Home", "PageUp", "PageDown"].includes(e.key)) {
          e.stopPropagation();
          if (!read && (e.key === "End" || e.key === "PageDown")) { e.preventDefault(); readOn(e.key === "End"); }
        }
      }}
      onFocus={(e) => setAt((e.target as Element) === text.current ? "text" : (e.target as Element) === approve.current ? "approve" : "")}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setAt(""); }}
    >
      <div className="flex items-center gap-2.5 px-4 pt-3">
        <span className="grid size-6 place-items-center rounded-md bg-accent-soft text-accent"><ClipboardList className="size-3.5" /></span>
        <span className="text-ui font-medium">{c.title || "The model's plan"}</span>
        <button onClick={() => setEditing(!editing)} className="ml-auto inline-flex min-h-ctl-sm items-center gap-1 text-caption text-faint hover:text-fg" data-testid="plan-edit">
          <Pencil className="size-3" /> {editing ? "Done editing" : "Edit"}
        </button>
      </div>
      <div ref={text} tabIndex={-1} data-ask="" className="mx-4 mt-2 max-h-80 overflow-auto rounded-lg border max-sm:max-h-none max-sm:overflow-visible border-line bg-bg px-3 py-2 text-ui outline-none focus-visible:border-line-strong" data-testid="plan-text">
        {editing
          ? <textarea value={plan} onChange={(e) => setPlan(e.target.value)} rows={12} className="w-full resize-y bg-transparent font-mono text-caption outline-none" />
          : <Markdown text={plan} />}
      </div>
      {back ? (
        <form ref={footRef} className="k-plan-foot flex items-center gap-2 px-4 py-3" onSubmit={(e) => { e.preventDefault(); send({ approve: false, feedback }); }}>
          <input autoFocus value={feedback} onChange={(e) => setFeedback(e.target.value)} placeholder="What to change in the plan" data-testid="plan-feedback"
            className="k-field min-w-0 flex-1" />
          <button type="submit" className="k-btn k-btn-lg">Send back</button>
          <button type="button" onClick={() => setBack(false)} className="h-8 rounded-lg px-2 text-ui text-faint hover:text-fg">Cancel</button>
        </form>
      ) : (
        <div ref={footRef} className="k-plan-foot flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
          {/* One unit: the mode the work goes on in, named, and the approval that starts it. They wrap inside it, never apart. */}
          <div className="flex min-w-0 max-w-full flex-wrap items-center gap-1.5 rounded-lg border border-line bg-sunken p-1" role="group" aria-label="Approve the plan" data-testid="plan-approval">
            <span className="flex min-w-0 flex-[1_1_auto] flex-wrap items-center gap-x-2 gap-y-1">
              <span className="k-plan-label shrink-0 pl-1.5 text-caption text-muted" aria-hidden>Work goes on in</span>
              <Select value={mode} onChange={(e) => setMode(e.target.value)} aria-label="Work goes on in" data-testid="plan-mode" className="k-field-sm w-[7.5rem] grow">
                {MODES.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              </Select>
            </span>
            <button
              ref={approve}
              data-testid="plan-approve"
              disabled={!plan.trim()}
              title={plan.trim() ? undefined : "The plan is empty: write it, or keep planning"}
              onClick={(e) => {
                // Only a plan that was read is approved, by any press (the card's own rule, first); a key not
                // as the keyboard arrives, under a dialog or when held.
                const unread = read ? "" : e.detail === 0 ? "Read the plan to its end first" : left.out > 0 ? `${share(left)} of the plan not seen yet: scroll through it` : STOOD;
                const no = unread || (e.detail === 0 ? keyRefused(e.currentTarget) : "");
                if (no) return setNudge(no);
                void send({ approve: true, mode, plan });
              }}
              className="h-7 grow whitespace-nowrap rounded-md bg-accent px-3 text-ui font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-50"
            >
              Approve plan
            </button>
          </div>
          <button data-testid="plan-back" onClick={() => setBack(true)} className="h-8 rounded-lg px-3 text-ui text-muted hover:bg-hover hover:text-fg">Keep planning</button>
          {/* One place for what the card says, as large as the most it can say (every line stacked in it,
              unseen), so the foot keeps its height and nothing moves under the pointer as the words change. */}
          <span className="ml-auto grid min-w-[8rem] flex-[1_1_0] justify-items-end text-right text-micro">
            {SAYS.map((w) => <span key={w} className="invisible col-start-1 row-start-1" aria-hidden="true">{w}</span>)}
            {err ? <span className="col-start-1 row-start-1 text-danger">{err}</span>
              // Why a press did nothing, on every screen.
              : nudge ? <span className="col-start-1 row-start-1 text-warn" role="status" data-testid="plan-hint">{nudge}</span>
              // A plan longer than where it shows: how much of it was not seen yet (no key is named).
              : (!hint || TOUCH.matches) && !read && left.long && left.n > 0 ? <span className="col-start-1 row-start-1 text-warn tabular-nums" role="status" data-testid="plan-left">{share(left)} not seen yet</span>
              // What the keys do where the keyboard is (where there is one).
              : <span className={cn("col-start-1 row-start-1 text-faint max-sm:hidden pointer-coarse:hidden", !hint && "invisible")} data-testid="plan-hint">{hint || "Enter approves the plan"}</span>}
          </span>
        </div>
      )}
    </div>
  );
}

// Everything the card's foot can say (the widest share stands for every share), stacked unseen in its place.
const STOOD = "Approve takes a press once the plan has stood a moment in view";
const SAYS = [
  STOOD, "100% of the plan not seen yet: scroll through it", "100% not seen yet", "Read the plan to its end first",
  "Read to the end, then Tab goes to Approve", "Tab goes to Approve", "Enter approves the plan",
  "Not yet: the keyboard has only just arrived", "Not while something lies over it", "A held key answers nothing",
];
// What of the plan was not seen, as a share of it: its lines are of a height, its rows of words are not.
const share = (l: { n: number; total: number }) => `${Math.max(1, Math.round((100 * l.n) / l.total))}%`;
// No keyboard: what a press refuses is said, a key is not.
const TOUCH = matchMedia("(pointer: coarse)");
