// A question the agent asks the owner (AskUserQuestion, request_user_input,
// ask_user). While it waits it is a card docked above the message box, where
// approvals and plans wait too: it cannot scroll away with the conversation,
// it takes the keyboard when it opens, and it is answered from the keyboard:
// a number picks an option, Enter sends, words go to the "own answer" field.
// The conversation shows a line while it waits and the record afterwards.
//
// A question an MCP server asks while its call runs (elicitation) is the same
// docked card, with what differs: it says which server asks and shows the
// server's words as plain text, the owner can decline it, and it is stricter
// with the keyboard. It never takes the keyboard by itself, a number only
// picks (no one key answers it), and a form that asks for what looks like a
// secret is sent only once the owner ticked "send anyway", by whatever key
// or press the answer comes; what is typed on such a card never goes on to
// the message box.
//
// A server can send the owner to a page instead (URL mode): the card shows the
// whole address with its site set apart and what to know before opening it.
// The owner opens it from the card, in their own browser and in a tab of its
// own that cannot reach this one; that is the answer. No key opens it but one
// on the Open link itself, and nothing else opens or fetches it.
import { Collapsible } from "@base-ui/react/collapsible";
import { Clock, ExternalLink, MessageCircleQuestion } from "lucide-react";
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { Under } from "./ToolCall.tsx";
import { CALL_STOPPED, NEEDS_ANSWER } from "../lib/work.ts";
import { WaitMark } from "./WaitMark.tsx";
import { STATE_WORD } from "../../../src/core/state-words.ts";
import { OUTSIDE_LABEL } from "../../../src/core/watch.ts";
import { stopKind } from "../../../src/core/stops.ts";
import type { Asked, AskedLink, ToolResultBlock, ToolUseBlock } from "../../../src/core/types.ts";
import { SETTLE_MS } from "../lib/approvals.ts";
import { dropRepeats, keyRefused, keysSettled, noteAnswer, noteOneKey, owned, typeToBox, useAskKeys, useHold } from "../lib/asks.ts";
import { composing } from "../lib/keys.ts";
import { later, useAway } from "../lib/later.ts";
import { usePhoneWidth } from "../lib/list-hold.ts";
import { openSession } from "../lib/automation.ts";
import { actions, api, failed, getState, reportError, useStore } from "../lib/store.ts";
import { askedQuestions, questions, resultText, siteOf, type UiQuestion } from "../lib/tools.ts";
import { cn, focusBox } from "../lib/utils.ts";
import { justOnce, keepRuling, useOfferMark, type Scope } from "../lib/rulings.ts";
import { Seg } from "./Seg.tsx";

type Picked = Record<string, string[]>;
// Unsent answers, per session and call: they outlive the card (a pane
// switch, a remount) until the question settles. Never sent by themselves.
const answerDrafts = new Map<string, { picked: Picked; other: Record<string, string> }>();
const NONE: string[] = [];
// A question's id can be any name a server gives a field (`__proto__`,
// `constructor`): only an entry the record itself holds is its answer.
const at = <T,>(o: Record<string, T> | undefined, k: string): T | undefined => (o && Object.hasOwn(o, k) ? o[k] : undefined);

// (`slim`: an open question of the agent's on a phone has no head row: the ring says it waits, the
// card's label says who asks, and the question's header leads its text. Its choices get the room.)
const Head = ({ open, answered, from, slim, onLater }: { open: boolean; answered: boolean; from?: string; slim?: boolean; onLater?: () => void }) => (
  <div className={cn("flex items-center gap-2 border-b border-line px-3.5 py-2 text-ui", slim && "max-md:hidden")}>
    <MessageCircleQuestion className={cn("size-3.5 shrink-0", open ? "text-accent-ink" : "text-muted")} />
    <span className="min-w-0 truncate font-medium" data-testid="question-from">{from !== undefined ? `MCP server ${from} is asking` : open ? "The agent is asking" : answered ? "Answered" : "Question"}</span>
    {onLater && (
      // Put away to the count in the session's head (lib/later.ts): the turn still waits for the answer.
      <button type="button" data-testid="ask-later" onClick={onLater} title="Put this away to the count in the head: the turn still waits for it" className="ml-auto inline-flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-2 text-caption text-muted outline-none hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-accent/40">
        <Clock className="size-3.5" aria-hidden="true" />Later
      </button>
    )}
    {open && <span className={cn("size-1.5 shrink-0 rounded-full bg-accent animate-pulse-dot", !onLater && "ml-auto")} />}
  </div>
);
// On a phone the header leads the question's first line: the text has the card's width.
const Legend = ({ q }: { q: UiQuestion }) => (
  <legend className="mb-1.5 flex items-baseline gap-2">
    {q.header && <span className="k-q-chip max-md:hidden">{q.header}</span>}
    <QuestionText text={q.question} header={q.header} />
  </legend>
);

// A phone cuts a long question at three lines (bridge.css), so that its choices show with it, and
// offers the rest: one tap and it reads whole. The cut is read from the page as it is laid out. Where
// the choices still do not all show (a large text size, a title of two lines), the cut goes to two
// lines: the choices come before the words that lead to them.
const CUT_LINES = 3, CUT_LEAST = 2;
function QuestionText({ text, header }: { text: string; header?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [cut, setCut] = useState(false);
  const [whole, setWhole] = useState(false);
  const [lines, setLines] = useState(CUT_LINES);
  useLayoutEffect(() => {
    const el = ref.current;
    const card = el?.closest<HTMLElement>(".k-question");
    const tray = el?.closest<HTMLElement>('[data-testid="composer-tray"]');
    if (!el || !card || !tray || whole || !matchMedia("(max-width: 767px)").matches) return;
    // Whether every choice stands in the tray, above the card's foot (the state the page has now).
    const shows = () => {
      const t = tray.getBoundingClientRect();
      const bottom = Math.min(t.bottom, card.querySelector('[data-testid="question-foot"]')?.getBoundingClientRect().top ?? Infinity);
      return [...card.querySelectorAll('[data-testid="question-option"]')].every((o) => { const r = o.getBoundingClientRect(); return r.bottom <= bottom + 1; });
    };
    const fit = () => setLines((n) => (n > CUT_LEAST && !shows() ? n - 1 : n));
    const ro = new ResizeObserver(fit);
    ro.observe(tray);
    ro.observe(card);
    const again = () => setLines(CUT_LINES);
    // Cut short, the choices also sit closer (bridge.css): a title of three lines needs both.
    card.toggleAttribute("data-tight", lines < CUT_LINES);
    addEventListener("resize", again);
    return () => { ro.disconnect(); removeEventListener("resize", again); };
  }, [text, whole, lines]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || whole) return;
    const look = () => setCut(el.scrollHeight > el.clientHeight + 1);
    look();
    const ro = new ResizeObserver(look);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text, whole]);
  // Cut, the text itself is the control (three lines are a finger's height): its last line ends in what a tap does.
  const open = cut && !whole;
  return (
    <span className="relative min-w-0">
      <span ref={ref} className="k-q-text text-read font-medium leading-snug" data-whole={whole || undefined} data-testid="question-text" style={lines < CUT_LINES ? ({ "--k-q-lines": lines } as CSSProperties) : undefined}
        role={open ? "button" : undefined} tabIndex={open ? 0 : undefined} aria-expanded={open ? false : undefined}
        onClick={open ? () => setWhole(true) : undefined} onKeyDown={open ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setWhole(true); } } : undefined}>{header && <span className="k-q-chip k-q-lead md:hidden">{header}</span>}{text}</span>
      {open && <span className="k-q-more" aria-hidden="true" data-testid="question-more">Read it all</span>}
    </span>
  );
}

// The page a server sends the owner to: the site, then the whole address.
const LinkShown = ({ link, from }: { link: AskedLink; from: string }) => {
  const [before, site, after] = siteOf(link.url, link.host);
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-line bg-sunken px-3 py-2.5" data-testid="question-link">
      <span className="k-label">{link.waiting ? "Finish the step at" : "Opens in your browser"}</span>
      <span className="text-read font-medium leading-snug break-all" data-testid="question-host">{link.host}</span>
      <span className="font-mono text-caption leading-snug break-all text-muted" data-testid="question-url">
        {before}<span className="font-semibold text-fg">{site}</span>{after}
      </span>
      {link.waiting && <span className="text-caption text-muted" data-testid="question-waiting">The call runs again when {from} says the step is done, or when you press I finished.</span>}
    </div>
  );
};

// In the conversation a question is a line of the rail, as every call is. One
// that waits says so in the owner's color (its card is above the message box);
// one that was answered, stopped or cut says what was asked and what was
// answered, and opens to its record.
export function QuestionCard({ use, result, sessionId }: { use: ToolUseBlock; result?: ToolResultBlock; sessionId?: string }) {
  const [show, setShow] = useState(false);
  const qs = questions(use.name, use.input);
  const answered = !!result && !result.is_error;
  const open = useStore((s) => !result && !!sessionId && !!s.questionCalls[sessionId]?.includes(use.id));
  // A session another harness runs asks there: Keel cannot answer it, so its question is a record here, never a card to answer.
  const outside = useStore((s) => (sessionId && !result ? s.sessions[sessionId]?.outside : undefined));
  // What the owner answered, by question (stored with the result); older records have only the result text.
  // `ruling`: a standing ruling answered it, with no card. `offer`: the owner answered it, and can keep the answer.
  const shown = (result as (ToolResultBlock & { shown?: Shown }) | undefined)?.shown;
  const given = shown?.answers;
  const ruled = shown?.ruling;
  const first = qs[0];
  if (open) {
    return (
      <div className="k-tool-call" data-testid="question-asked" data-state="waiting">
        <div className="k-line">
          <span className="k-line-text">
            <span className="k-line-verb">Asks</span>{" "}
            {/* Its card is above the message box and holds the question: the line says only that it waits. */}
            <WaitMark words={NEEDS_ANSWER} />
          </span>
        </div>
      </div>
    );
  }
  const said = first && given ? [...(given[first.id]?.picked ?? []), ...(given[first.id]?.other?.trim() ? [given[first.id]!.other!.trim()] : [])].join(", ") : "";
  const ended = result?.is_error ? stopKind(result.content) : undefined;
  return (
    <Collapsible.Root open={show} onOpenChange={setShow} className="k-tool-call k-question" data-testid="question" data-state={answered ? "answered" : outside ? "elsewhere" : "closed"}>
      <Collapsible.Trigger className="k-line">
        <span className="k-line-text">
          <span className="k-line-verb">{answered ? "Asked" : outside ? "Asks" : "Question"}</span>{" "}
          {!answered && outside && <><span className="k-line-state" data-tone={outside.state === "waiting" ? "need" : "idle"} data-testid="question-elsewhere">{outside.state === "waiting" ? `waits in ${OUTSIDE_LABEL[outside.harness]}` : `no answer recorded in ${OUTSIDE_LABEL[outside.harness]}`}</span>{" "}</>}
          {!answered && !outside && <><span className="k-line-state" data-tone={ended === "cut" ? "warn" : "idle"}>{ended === "cut" ? "cut by a restart" : ended === "stopped" ? CALL_STOPPED : "not answered"}</span>{" "}</>}
          <span className="k-line-what" data-words="">{first?.question ?? ""}</span>
          {qs.length > 1 && <>{" "}<span className="k-line-rest">+{qs.length - 1}</span></>}
          {said && <>{" "}<span className="k-line-answer" data-testid="question-line-answer">{said}</span></>}
          {ruled && <>{" "}<span className="k-line-state" data-tone="idle" data-testid="question-ruled">from your standing ruling</span></>}
        </span>
        <span className="k-line-end" />
      </Collapsible.Trigger>
      {answered && shown?.offer && !ruled && sessionId && <RulingOffer sessionId={sessionId} callId={use.id} offer={shown.offer} />}
      <Collapsible.Panel className="k-tool-panel overflow-hidden">
      {/* The record, in the rail's own rows: what was asked with what it offered (what was chosen marked), and what the owner said. */}
      <div className="k-under k-question-record">
        {qs.map((q) => (
          <Fragment key={q.id}>
            <Under name={q.header || "Asked"}>
              {q.question}
              {q.options.length > 0 && (
                <span className="k-opts" role={q.multi ? "group" : "radiogroup"}>
                  {q.options.map((o) => {
                    const on = (given?.[q.id]?.picked ?? NONE).includes(o.label);
                    return <span key={o.label} role={q.multi ? "checkbox" : "radio"} aria-checked={on} aria-disabled="true" className="k-opt" data-on={on ? "" : undefined} data-testid="question-option" title={o.description}>{o.label}</span>;
                  })}
                </span>
              )}
            </Under>
            {given && (
              <Under name={ruled ? "Ruling" : "You"} testid="question-answer">
                {[...(given[q.id]?.picked ?? []), ...(given[q.id]?.other?.trim() ? [given[q.id]!.other!.trim()] : [])].join(", ") || "no answer"}
              </Under>
            )}
          </Fragment>
        ))}
        {ruled && <Under name="Kept" testid="question-ruling">{`For questions like it ${inScope(ruled)}. You did not see this question; revoke the ruling in Customize > Rulings.`}</Under>}
        {result && !given && <Under name={result.is_error && !stopKind(result.content) ? STATE_WORD.fail : "Result"} tone={result.is_error && !stopKind(result.content) ? "fail" : undefined} testid="question-result">{resultText(result)}</Under>}
      </div>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

type Shown = { answers?: Record<string, { picked: string[]; other?: string }>; ruling?: { id: string; scope: Scope; name: string; words: string[] }; offer?: { scopes: { scope: Scope; name: string }[] } };
const SCOPE_WORD: Record<Scope, string> = { tree: "This tree", repo: "Repository", everywhere: "Everywhere" };
const inScope = (s: { scope: Scope; name: string }) => (s.scope === "everywhere" ? "everywhere" : s.scope === "tree" ? "in this tree of agents" : `in ${s.name}`);

// One line under an answer the owner gave: keep it for questions like it (a
// standing ruling, src/automation/rulings.ts), in a scope the question was
// asked in, or say it was just this once. Once kept, the line says where.
function RulingOffer({ sessionId, callId, offer }: { sessionId: string; callId: string; offer: NonNullable<Shown["offer"]> }) {
  const mark = useOfferMark(sessionId, callId, true);
  const scopes = offer.scopes;
  const [scope, setScope] = useState<Scope>(() => scopes.find((s) => s.scope === "repo")?.scope ?? scopes[0]?.scope ?? "tree");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  if (!mark || mark.state === "one-off" || !scopes.length) return null;
  if (mark.state === "kept") {
    const gone = !!mark.rulings?.length && mark.rulings.every((r) => r.revoked);
    const at = scopes.find((s) => s.scope === mark.scope) ?? { scope: mark.scope ?? "tree", name: mark.name ?? "" };
    return <div className="k-ruling-offer" data-testid="ruling-offer" data-state={gone ? "revoked" : "kept"}><span className="k-ruling-words">{gone ? "Its ruling was revoked." : `Kept for questions like it ${inScope(at)}.`}</span></div>;
  }
  const chosen = scopes.find((s) => s.scope === scope) ?? scopes[0]!;
  const act = async (f: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setErr("");
    try { await f(); } catch (e) { setErr(failed(e, { at: "RulingOffer" })); } finally { setBusy(false); }
  };
  return (
    <div className="k-ruling-offer" data-testid="ruling-offer" data-state="open">
      <span className="k-ruling-words">Keep this for questions like it <span className="k-ruling-scope" data-testid="ruling-scope-name">{inScope(chosen)}</span>?</span>
      {scopes.length > 1 && <Seg label="Where the ruling holds" testid="ruling-scope" value={scope} onChange={setScope} options={scopes.map((s) => ({ value: s.scope, label: SCOPE_WORD[s.scope], title: s.scope === "everywhere" ? "Every agent" : s.name, testid: `ruling-scope-${s.scope}` }))} />}
      <button type="button" className="k-btn" data-ink="" disabled={busy} data-testid="ruling-keep" onClick={() => act(() => keepRuling(sessionId, callId, scope))}>Keep</button>
      <button type="button" className="k-btn" data-quiet="" disabled={busy} data-testid="ruling-once" onClick={() => act(() => justOnce(sessionId, callId))}>Just this once</button>
      {err && <span className="k-ruling-err" role="alert">{err}</span>}
    </div>
  );
}

// The questions of a session that wait for an answer, above its message box.
// `agent`: the session is one of the view's agents, whose transcript the page does not hold: the
// calls that ask come from the daemon, only while they wait. `lead`: the first card takes the
// keyboard as it appears (one card in a pane does).
export function Questions({ sessionId, agent, lead = true }: { sessionId: string; agent?: boolean; lead?: boolean }) {
  const calls = useStore((s) => s.questionCalls[sessionId]) ?? NONE;
  const events = useStore((s) => (agent ? undefined : s.events[sessionId]));
  const { told, lost } = useAskedCalls(sessionId, agent ? calls : NONE);
  const uses = useMemo(() => {
    if (!calls.length) return [];
    if (agent) return calls.map((id) => told.get(id)).filter((u): u is ToolUseBlock => !!u);
    if (!events) return [];
    const found = new Map<string, ToolUseBlock>();
    for (let i = events.length - 1; i >= 0 && found.size < calls.length; i--) {
      const e = events[i]!;
      if (e.kind === "assistant") for (const b of e.data.blocks as ToolUseBlock[]) if (b.type === "tool_use" && calls.includes(b.id)) found.set(b.id, b);
    }
    return calls.map((id) => found.get(id)).filter((u): u is ToolUseBlock => !!u);
  }, [calls, events, told, agent]);
  // What a server asked on a call that runs (the call's input is not the question).
  const asks = useStore((s) => s.questionAsks[sessionId]);
  // Put away with Later (an agent's questions are answered where they are asked: no Later there).
  const away = useAway(sessionId);
  const shown = !agent && away.size ? uses.filter((u) => !away.has(u.id)) : uses;
  if (!shown.length && !lost) return null;
  return (
    <div className={agent ? "flex flex-col gap-2" : "mb-2 flex flex-col gap-2"}>
      {shown.map((u, i) => {
        const asked = at(asks, u.id);
        // (A card of its own per question: a server's next one on the same call starts empty and takes an answer.)
        return <Docked key={asked ? `${u.id}:${asked.id}` : u.id} use={u} sessionId={sessionId} first={lead && i === 0} asked={asked} onLater={agent ? undefined : () => { later.put(sessionId, u.id); requestAnimationFrame(() => focusBox(sessionId)); }} />;
      })}
      {lost && (
        <p data-testid="question-unreadable" className="text-caption text-muted">
          This question could not be read here: <button type="button" onClick={() => openSession(sessionId)} className="text-accent-ink underline underline-offset-2 hover:text-fg">open the agent to answer</button>.
        </p>
      )}
    </div>
  );
}

// The calls that ask an agent's open questions, read from the daemon once per set of calls. A read that fails
// or lacks a call (an older peer, a connection that dropped) is made once more; `lost` says a call is still
// missing after that, and the card tells the owner to open the agent.
const RETRY_MS = 1500;
function useAskedCalls(sessionId: string, calls: string[]): { told: Map<string, ToolUseBlock>; lost: boolean } {
  const [got, setGot] = useState(() => new Map<string, ToolUseBlock>());
  const [lostFor, setLostFor] = useState("");
  const key = calls.join();
  useEffect(() => {
    if (!key) return;
    let gone = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const want = key.split(",");
    const read = (retry: boolean) => {
      api<{ calls?: { call_id: string; name: string; input: unknown }[] }>(`/api/sessions/${sessionId}/questions`)
        .then((r) => (r.calls ?? []).map((c) => [c.call_id, { type: "tool_use", id: c.call_id, name: c.name, input: c.input } as ToolUseBlock] as const))
        .catch((e) => { if ((e as { status?: number }).status !== 404 && retry) reportError(e, { at: "agent question" }); return [] as (readonly [string, ToolUseBlock])[]; })
        .then((found) => {
          if (gone) return;
          if (found.length) setGot(new Map(found));
          if (want.every((id) => found.some(([c]) => c === id))) setLostFor("");
          else if (!retry) timer = setTimeout(() => read(true), RETRY_MS);
          else setLostFor(key);
        });
    };
    read(false);
    return () => { gone = true; clearTimeout(timer); };
  }, [sessionId, key]);
  return { told: got, lost: !!key && lostFor === key };
}

// In the conversation, under a call whose server asks the owner something: a
// line that says so (the card is above the message box).
export function AskedUnder({ use, sessionId, children }: { use: ToolUseBlock; sessionId?: string; children: ReactNode }) {
  const asked = useStore((s) => (sessionId ? at(s.questionAsks[sessionId], use.id) : undefined));
  // (The call is at the same place in the tree with the line and without: it is never made again.)
  return (
    <>
      {children}
      {/* A line of the rail, as the call above it is. */}
      {asked && <div className="k-line" data-testid="question-asked">
        <span className="k-line-text">
          <span className="k-line-verb">Asks</span>{" "}
          <WaitMark words={NEEDS_ANSWER} />
        </span>
      </div>}
    </>
  );
}

// The docked card is held to the one rule of lib/asks.ts. The keyboard comes
// to the card itself, where nothing answers. What is typed there goes to the
// message box. A number is the card's only once the owner put the keyboard on
// it (their Tab, arrow or press, or the key that goes to what waits): then it
// picks an option, and on a card that is one question with one choice it
// answers with it, if that option is whole in view. Enter sends what is shown
// chosen. No key answers within the settle time of the keyboard arriving, by
// being held, or under a dialog.
// `asked`: the question is not the call's input but what a server asked while the call ran.
function Docked({ use, sessionId, first, asked, onLater }: { use: ToolUseBlock; sessionId: string; first: boolean; asked?: Asked; onLater?: () => void }) {
  const qs = useMemo(() => (asked ? askedQuestions(asked) : questions(use.name, use.input)), [asked, use.name, use.input]);
  const key = asked ? `${sessionId}:${use.id}:${asked.id}` : `${sessionId}:${use.id}`;
  const slimPhone = usePhoneWidth() && !asked;
  const [picked, setPicked] = useState<Picked>(() => answerDrafts.get(key)?.picked ?? {});
  const [other, setOther] = useState<Record<string, string>>(() => answerDrafts.get(key)?.other ?? {});
  const [sending, setSending] = useState(false);
  const inflight = useRef(false);
  const [err, setErr] = useState("");
  const [nudge, setNudge] = useState("");
  const root = useRef<HTMLDivElement>(null);
  // The first question of a session takes the keyboard as it appears; one behind it waits its turn.
  // A server's question never takes it: the owner goes to it.
  const held = useAskKeys(root, first && !asked);
  const hold = useHold(root);
  // A form that asks for what looks like a secret is sent only on the owner's word.
  const [sendAnyway, setSendAnyway] = useState(false);
  useEffect(() => {
    // (What was typed into a masked field is not kept past the card.)
    if (Object.keys(picked).length || Object.values(other).some((t) => t)) answerDrafts.set(key, { picked, other: Object.fromEntries(Object.entries(other).filter(([id]) => !qs.find((q) => q.id === id)?.secret)) });
  }, [key, picked, other, qs]);
  // A question asked again (the answer did not fit) takes an answer again, with what was typed still there.
  useEffect(() => {
    inflight.current = false;
    setSending(false);
  }, [asked?.round]);
  // A card that leaves because its pane closed keeps its draft; one whose question is settled drops it.
  useEffect(() => () => { if (!getState().questionCalls[sessionId]?.includes(use.id)) answerDrafts.delete(key); }, []);
  // An answer on its way is over when the daemon went away under it: the card
  // takes an answer again when it is back.
  const connected = useStore((s) => s.connected);
  useEffect(() => {
    if (connected) return;
    inflight.current = false;
    setSending(false);
  }, [connected]);
  useEffect(() => {
    if (!nudge) return;
    const t = window.setTimeout(() => setNudge(""), SETTLE_MS * 2);
    return () => window.clearTimeout(t);
  }, [nudge]);

  const has = (p: Picked, q: UiQuestion) => (at(p, q.id)?.length ?? 0) > 0 || !!(at(other, q.id) ?? "").trim();
  // Every part that needs an answer has one (a server's form may leave some optional).
  const complete = (p: Picked) => qs.every((q) => q.optional || has(p, q));
  // The gate of a form that asks for what looks like a secret: no key and no press sends it unticked.
  const gated = !!asked?.sensitive && !sendAnyway;
  // A page to open, and whether the owner already went to it.
  const link = asked?.link;
  const toOpen = !!link && !link.waiting;
  const ready = !gated && complete(picked);
  const toggled = (p: Picked, q: UiQuestion, label: string): Picked => {
    const cur = at(p, q.id) ?? [];
    return { ...p, [q.id]: q.multi ? (cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label]) : [label] };
  };
  // One answer per question card: Enter and the button share the guard while it is on its way.
  const submit = async (p: Picked = picked) => {
    if (inflight.current || gated) return;
    inflight.current = true;
    held.current = !!root.current?.contains(document.activeElement);
    noteAnswer(use.id);
    setSending(true);
    setErr("");
    try {
      await actions.answer(sessionId, use.id, Object.fromEntries(qs.map((q) => [q.id, { picked: at(p, q.id) ?? [], other: at(other, q.id) }])), !!asked?.sensitive && sendAnyway, asked?.id);
    } catch (e) {
      setErr(failed(e, { at: "QuestionCard" }));
      setSending(false);
      inflight.current = false;
    }
  };
  // A server's question can be declined. `no`: why the key that asked may not answer now (lib/asks.ts).
  const decline = async (no = "") => {
    if (no) return setNudge(no);
    if (!asked || inflight.current) return;
    inflight.current = true;
    held.current = !!root.current?.contains(document.activeElement);
    noteAnswer(use.id);
    setSending(true);
    setErr("");
    try {
      await actions.declineQuestion(sessionId, use.id, asked.id);
    } catch (e) {
      setErr(failed(e, { at: "QuestionCard" }));
      setSending(false);
      inflight.current = false;
    }
  };
  // Sends, or says why not. `no`: why the key that asked may not answer now (lib/asks.ts).
  const send = (p: Picked = picked, no = "") => {
    if (no) return setNudge(no);
    if (!complete(p)) return setNudge(qs.length > 1 ? "Choose an answer for each question first" : "Choose an answer or type one first");
    if (gated) return setNudge("Tick \"Send anyway\" first, or decline");
    setNudge("");
    void submit(p);
  };

  // One number answers a card that is one question with one choice to make.
  // (Never a server's question: there a number picks, and Enter or Answer sends what is shown.)
  const oneKey = !asked && qs.length === 1 && !qs[0]!.multi && qs[0]!.options.length > 0;
  const most = Math.min(9, Math.max(0, ...qs.map((q) => q.options.length)));
  const digits = most > 1 ? `1 to ${most}` : "1";
  // Numbers are the card's own only once the owner put the keyboard on it and it has been there for
  // the settle time. Until then a number typed here goes on to the message box with the rest of
  // what is typed (so that all of it gets there, or none), and no number is drawn on the options:
  // the card shows a key only while that key answers, and the hint says what the keys do now.
  const digitsOn = hold.own && hold.keys === "ready";
  const hint = link ? (toOpen ? "Tab goes to Open, Enter there opens the page" : "Enter says you finished")
    : !most ? "Tab goes to the field, Enter sends"
    : !digitsOn ? "Up and Down choose, Enter sends"
    : oneKey ? `Press ${digits} to answer, or Up and Down then Enter`
    : `${digits} or Up and Down choose, Enter sends`;
  // Whole in the region above the message box, over the card's own Answer row: where the owner can read it.
  const inView = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const tray = el.closest('[data-testid="composer-tray"]')?.getBoundingClientRect();
    const foot = root.current?.querySelector('[data-testid="question-foot"]')?.getBoundingClientRect();
    return r.height > 0 && r.top >= Math.max(0, tray?.top ?? 0) - 0.5 && r.bottom <= Math.min(innerHeight, tray?.bottom ?? innerHeight, foot?.top ?? innerHeight) + 0.5;
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey || composing(e) || sending) return;
    const t = e.target as HTMLElement;
    const field = t.tagName === "INPUT";
    // Up and Down move through the options, the own-answer fields and Answer, from any of them.
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !e.shiftKey) {
      const stops = [...e.currentTarget.querySelectorAll<HTMLElement>('[data-testid="question-option"], [data-testid="question-other"], [data-testid="question-send-anyway"], [data-testid="question-submit"]:not(:disabled), [data-testid="question-open"], [data-testid="question-decline"]')];
      const i = stops.indexOf(t);
      const to = i < 0 ? (e.key === "ArrowDown" ? stops[0] : stops.at(-1)) : stops[i + (e.key === "ArrowDown" ? 1 : -1)];
      if (!to) return;
      e.preventDefault();
      to.focus();
      return;
    }
    // The part the key is for: the one the keyboard is in, else the first.
    const at = t.closest<HTMLElement>("fieldset[data-q]")?.dataset.q;
    const q = qs.find((x) => x.id === at) ?? qs[0];
    if (e.key === "Enter") {
      if (t.dataset.testid === "question-submit" || t.dataset.testid === "question-decline" || t.dataset.testid === "question-open") return; // the button's own press
      e.preventDefault();
      // Only the Open link opens the page: Enter elsewhere on the card does not send the owner anywhere.
      if (toOpen) return setNudge("Open the page with its link, or decline");
      // On an option of a part that has no choice yet, Enter takes it. What is sent is what the card shows chosen.
      const label = t.closest<HTMLElement>('[data-testid="question-option"]')?.dataset.label;
      const own = qs.find((x) => x.id === at);
      const no = keyRefused(t, e.repeat);
      const next = !no && label !== undefined && own && !has(picked, own) ? toggled(picked, own, label) : picked;
      if (next !== picked) setPicked(next);
      return send(next, no);
    }
    if (field || !q) return;
    // A number is the card's own once the owner put the keyboard on it and it has settled: it picks, in the part the keyboard is in.
    // Brought here by the owner and pressed too soon after it showed (lib/asks.ts): the number is the
    // card's all the same, and it does nothing: never typed into the message box, never a message.
    if (/^[1-9]$/.test(e.key) && !e.shiftKey && owned(t) && !keysSettled(t) && q.options[Number(e.key) - 1]) {
      e.preventDefault();
      return setNudge(keyRefused(t, e.repeat) || "Not yet: the keyboard has only just arrived");
    }
    // Rested here by a step of the sequence after an answer one key gave by itself (lib/asks.ts,
    // noteOneKey): no number is the card's until the owner's own Down or Tab. It answers nothing, and
    // the card says what does.
    if (/^[1-9]$/.test(e.key) && !e.shiftKey && !owned(t) && hold.keys !== "" && !hold.take && q.options[Number(e.key) - 1]) {
      e.preventDefault();
      return setNudge("Down first, then a number answers");
    }
    if (/^[1-9]$/.test(e.key) && !e.shiftKey && owned(t) && keysSettled(t)) {
      const o = q.options[Number(e.key) - 1];
      if (!o) return;
      e.preventDefault();
      const no = keyRefused(t, e.repeat);
      if (no) return setNudge(no);
      const next = toggled(picked, q, o.label);
      setPicked(next);
      setNudge("");
      const el = e.currentTarget.querySelector<HTMLElement>(`fieldset[data-q="${CSS.escape(q.id)}"] [data-testid="question-option"][data-n="${e.key}"]`);
      // An option out of view is chosen and brought into view, not sent: what is answered is what the owner can read.
      if (oneKey && el && inView(el)) { noteOneKey(use.id); void submit(next); }
      else el?.scrollIntoView({ block: "nearest" });
      return;
    }
    // Anything else typed on the card is for the message box. Not on a form
    // that asks for what looks like a secret: a word typed there would land
    // in the plain box, and Enter would send it to the model.
    if (asked?.sensitive) {
      if (e.key.length === 1 && e.key !== " ") { e.preventDefault(); setNudge("Tab goes to the fields"); }
      return;
    }
    typeToBox(e);
  };

  return (
    <div
      ref={root}
      tabIndex={-1}
      role="group"
      aria-label={asked ? `MCP server ${asked.from} is asking: ${asked.message}` : `The agent is asking: ${qs[0]?.question ?? ""}`}
      className="k-question group/card rounded-lg border border-accent/50 bg-raised shadow-2 outline-none animate-in"
      data-testid="question"
      data-state="open"
      data-call={use.id}
      data-ask-card=""
      data-ask=""
      data-keys={hold.keys || undefined}
      data-own={hold.own || undefined}
      data-digits={digitsOn || undefined}
      onKeyDownCapture={dropRepeats}
      onKeyDown={onKeyDown}
    >
      <Head open answered={false} from={asked?.from} slim={!asked} onLater={slimPhone ? undefined : onLater} />
      <div className="flex flex-col gap-4 px-3.5 pt-3 max-md:pt-2">
        {asked && (
          // The server's own words: plain text set apart from the card's, never markup or a link.
          <div className="k-quote flex flex-col gap-1" data-testid="question-message">
            <span className="k-label" data-testid="question-label">{asked.label || "From the server"}</span>
            <p className="whitespace-pre-wrap break-words text-read leading-snug">{asked.message || "The server gave no message."}</p>
          </div>
        )}
        {link && <LinkShown link={link} from={asked!.from} />}
        {asked?.notes?.map((n) => <p key={n} className="text-caption text-warn" data-testid="question-notes">{n}</p>)}
        {asked?.note && <p className="text-caption text-warn" data-testid="question-note">{asked.note}</p>}
        {qs.map((q) => (
          // (No wider than the card: a fieldset is as wide as its widest content by default, and a cut text's is its whole line.)
          <fieldset key={q.id} data-q={q.id} className="flex min-w-0 flex-col gap-2 max-md:gap-1">
            <Legend q={q} />
            {q.options.length > 0 && (
              <div className="grid gap-1.5 sm:grid-cols-2" role={q.multi ? "group" : "radiogroup"}>
                {q.options.map((o, i) => {
                  const on = (at(picked, q.id) ?? NONE).includes(o.label);
                  return (
                    <button
                      key={o.label}
                      type="button"
                      role={q.multi ? "checkbox" : "radio"}
                      aria-checked={on}
                      aria-keyshortcuts={i < 9 ? String(i + 1) : undefined}
                      disabled={sending}
                      onClick={() => setPicked((p) => toggled(p, q, o.label))}
                      data-testid="question-option"
                      data-label={o.label}
                      data-n={i + 1}
                      className={cn(
                        // (Brought into view, it stops over the card's Answer row, not under it.)
                        "k-q-option flex scroll-mb-14 items-start gap-2.5 rounded-md border px-3 py-2 max-md:py-1.5 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent/30",
                        on ? "border-accent bg-accent-soft" : "border-line bg-sunken hover:border-line-strong",
                      )}
                    >
                      {/* The key that picks it, drawn only while it does (the numbers are the card's). Else the
                          mark of a choice, in the same room: nothing moves when the numbers come. */}
                      {digitsOn && i < 9
                        ? <kbd aria-hidden="true" data-testid="question-digit" data-n={i + 1} className="k-cap-n mt-px grid size-[1.125rem] shrink-0 place-items-center rounded-xs border border-line-strong bg-raised text-micro font-medium text-fg pointer-coarse:hidden" />
                        : <span aria-hidden="true" className="mt-px grid size-[1.125rem] shrink-0 place-items-center pointer-coarse:hidden"><span className={cn("size-2.5 border", q.multi ? "rounded-xs" : "rounded-full", on ? "border-accent bg-accent" : "border-line-strong")} /></span>}
                      <span className="flex min-w-0 flex-col gap-0.5">
                        <span className="text-ui font-medium">{o.label}</span>
                        {o.description && <span className="text-caption leading-snug text-muted">{o.description}</span>}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
            <input
              value={at(other, q.id) ?? ""}
              onChange={(e) => setOther((o) => ({ ...o, [q.id]: e.target.value }))}
              type={q.secret ? "password" : "text"}
              autoComplete="off"
              disabled={sending}
              aria-label={q.options.length ? `Your own answer to: ${q.question}` : `Your answer to: ${q.question}`}
              placeholder={q.options.length ? "Or type your own answer" : "Type your answer"}
              data-testid="question-other"
              className="k-field"
            />
          </fieldset>
        ))}
        {asked?.sensitive && (
          <label className="flex items-start gap-2 text-ui">
            <input type="checkbox" checked={sendAnyway} disabled={sending} onChange={(e) => setSendAnyway(e.target.checked)} className="mt-0.5 accent-[var(--accent)]" data-testid="question-send-anyway" />
            <span>Send anyway <span className="text-muted">(the answer goes to the server {asked.from}; declining is the safe answer)</span></span>
          </label>
        )}
        {/* Answer stays at the card's lower edge while a long question scrolls under it. */}
        <div className="sticky bottom-0 -mx-3.5 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-b-lg border-t border-line bg-raised px-3.5 py-2.5 max-md:py-1.5" data-testid="question-foot">
          {!toOpen && (
            <button
              type="button"
              disabled={!ready || sending}
              // A key on the button answers as Enter does: not as the keyboard arrives, not under a dialog.
              onClick={(e) => send(picked, e.detail === 0 ? keyRefused(e.currentTarget) : "")}
              data-testid="question-submit"
              className="h-8 rounded-md bg-accent px-3.5 text-ui font-medium text-accent-fg transition-opacity hover:bg-accent-hover disabled:opacity-40"
            >
              {sending ? "Sending" : link ? "I finished" : asked && !qs.length ? "Confirm" : "Answer"}
            </button>
          )}
          {link && (
            // The owner's own browser opens it, in a tab that cannot reach this page and is not told where it came
            // from. Going there is the answer; the same link on a card that waits opens it again and answers nothing.
            <a
              href={link.url}
              target="_blank"
              rel="noopener noreferrer"
              referrerPolicy="no-referrer"
              aria-disabled={sending || undefined}
              onClick={(e) => {
                const no = e.detail === 0 ? keyRefused(e.currentTarget) : "";
                if (sending || no) { e.preventDefault(); if (no) setNudge(no); return; }
                if (toOpen) void submit({});
              }}
              data-testid="question-open"
              className={toOpen
                ? "inline-flex h-8 min-w-0 items-center gap-1.5 rounded-md bg-accent px-3.5 text-ui font-medium text-accent-fg transition-opacity hover:bg-accent-hover aria-disabled:opacity-40 outline-none focus-visible:ring-2 focus-visible:ring-accent/30"
                : "k-btn k-btn-lg"}
            >
              <span className="truncate">{toOpen ? `Open ${link.host}` : "Open again"}</span>
              <ExternalLink aria-hidden="true" className="size-3.5 shrink-0" />
            </a>
          )}
          {asked && (
            <button
              type="button"
              disabled={sending}
              // (A key on it declines as a key on any answer answers: not as the keyboard arrives, not under a dialog.)
              onClick={(e) => void decline(e.detail === 0 ? keyRefused(e.currentTarget) : "")}
              data-testid="question-decline"
              className="k-btn k-btn-lg"
            >
              {link?.waiting ? "Cancel" : "Decline"}
            </button>
          )}
          {/* An open question of the agent's has no head row on a phone, so Later stands in the foot. */}
          {slimPhone && onLater && (
            <button type="button" data-testid="ask-later" onClick={onLater} title="Put this away to the count in the head: the turn still waits for it" className="k-btn k-btn-lg ml-auto">
              <Clock className="size-3.5" aria-hidden="true" />Later
            </button>
          )}
          {err && <span className="text-caption text-danger" role="alert">{err}</span>}
          {/* Why a key did nothing, else what the keys do while the card has the keyboard. */}
          {nudge ? <span className="ml-auto text-micro text-warn" role="status" data-testid="question-nudge">{nudge}</span>
            : <span className={cn("invisible ml-auto text-micro text-faint max-sm:hidden pointer-coarse:hidden", hold.keys === "ready" && "group-focus-within/card:visible")} data-testid="question-hint">{hint}</span>}
        </div>
      </div>
    </div>
  );
}
