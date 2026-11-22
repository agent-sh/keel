// A question the agent asks the owner (AskUserQuestion, request_user_input,
// ask_user). While it waits it is a card docked above the message box, where
// approvals and plans wait too: it cannot scroll away with the conversation,
// it takes the keyboard when it opens, and it is answered from the keyboard:
// a number picks an option, Enter sends, words go to the "own answer" field.
// The conversation shows a line while it waits and the record afterwards.
import { MessageCircleQuestion } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { stopKind } from "../../../src/core/stops.ts";
import type { ToolResultBlock, ToolUseBlock } from "../../../src/core/types.ts";
import { SETTLE_MS } from "../lib/approvals.ts";
import { dropRepeats, keyRefused, keysSettled, noteAnswer, owned, typeToBox, useAskKeys, useHold } from "../lib/asks.ts";
import { composing } from "../lib/keys.ts";
import { actions, failed, getState, useStore } from "../lib/store.ts";
import { questions, resultText, type UiQuestion } from "../lib/tools.ts";
import { cn } from "../lib/utils.ts";

type Picked = Record<string, string[]>;
// Unsent answers, per session and call: they outlive the card (a pane
// switch, a remount) until the question settles. Never sent by themselves.
const answerDrafts = new Map<string, { picked: Picked; other: Record<string, string> }>();
const NONE: string[] = [];

const Head = ({ open, answered }: { open: boolean; answered: boolean }) => (
  <div className="flex items-center gap-2 border-b border-line px-3.5 py-2 text-ui">
    <MessageCircleQuestion className={cn("size-3.5", open ? "text-accent-ink" : "text-muted")} />
    <span className="font-medium">{open ? "The agent is asking" : answered ? "Answered" : "Question"}</span>
    {open && <span className="ml-auto size-1.5 rounded-full bg-accent animate-pulse-dot" />}
  </div>
);
const Legend = ({ q }: { q: UiQuestion }) => (
  <legend className="mb-1.5 flex items-baseline gap-2">
    {q.header && <span className="rounded-md bg-accent-soft px-1.5 py-px text-micro font-medium uppercase tracking-wide text-accent-ink">{q.header}</span>}
    <span className="text-read font-medium leading-snug">{q.question}</span>
  </legend>
);

// In the conversation. A question that waits is a line (its card is above the
// message box); one that was answered, stopped or cut is its record.
export function QuestionCard({ use, result, sessionId }: { use: ToolUseBlock; result?: ToolResultBlock; sessionId?: string }) {
  const qs = questions(use.name, use.input);
  const answered = !!result && !result.is_error;
  const open = useStore((s) => !result && !!sessionId && !!s.questionCalls[sessionId]?.includes(use.id));
  // What the owner answered, by question (stored with the result); older records have only the result text.
  const given = (result as (ToolResultBlock & { shown?: { answers?: Record<string, { picked: string[]; other?: string }> } }) | undefined)?.shown?.answers;
  if (open) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-line bg-raised px-3.5 py-2 text-ui" data-testid="question-asked">
        <MessageCircleQuestion className="size-3.5 shrink-0 text-accent-ink" />
        <span className="shrink-0 font-medium">Asking you</span>
        <span className="min-w-0 truncate text-muted">{qs[0]?.question}{qs.length > 1 ? ` and ${qs.length - 1} more` : ""}</span>
      </div>
    );
  }
  return (
    <div className="k-question rounded-lg border border-line bg-raised shadow-1 animate-in" data-testid="question" data-state={answered ? "answered" : "closed"}>
      <Head open={false} answered={answered} />
      <div className="flex flex-col gap-4 px-3.5 py-3">
        {qs.map((q) => (
          <fieldset key={q.id} className="flex flex-col gap-2">
            <Legend q={q} />
            {q.options.length > 0 && (
              <div className="grid gap-1.5 sm:grid-cols-2" role={q.multi ? "group" : "radiogroup"}>
                {q.options.map((o) => {
                  const on = (given?.[q.id]?.picked ?? NONE).includes(o.label);
                  return (
                    <button key={o.label} type="button" role={q.multi ? "checkbox" : "radio"} aria-checked={on} disabled data-testid="question-option"
                      className={cn("flex cursor-default flex-col items-start gap-0.5 rounded-md border px-3 py-2 text-left opacity-80", on ? "border-accent bg-accent-soft" : "border-line bg-sunken")}>
                      <span className="text-ui font-medium">{o.label}</span>
                      {o.description && <span className="text-caption leading-snug text-muted">{o.description}</span>}
                    </button>
                  );
                })}
              </div>
            )}
            {given && (
              <p className="whitespace-pre-wrap break-words text-caption text-muted" data-testid="question-answer">
                <span className="font-medium text-fg">Answered: </span>
                {[...(given[q.id]?.picked ?? []), ...(given[q.id]?.other?.trim() ? [given[q.id]!.other!.trim()] : [])].join(", ") || "no answer"}
              </p>
            )}
          </fieldset>
        ))}
        {result && !given && (
          <p className={cn("whitespace-pre-wrap break-words text-caption", result.is_error && !stopKind(result.content) ? "text-danger" : "text-muted")} data-testid="question-result">
            {resultText(result)}
          </p>
        )}
      </div>
    </div>
  );
}

// The questions of a session that wait for an answer, above its message box.
export function Questions({ sessionId }: { sessionId: string }) {
  const calls = useStore((s) => s.questionCalls[sessionId]) ?? NONE;
  const events = useStore((s) => s.events[sessionId]);
  const uses = useMemo(() => {
    if (!calls.length || !events) return [];
    const found = new Map<string, ToolUseBlock>();
    for (let i = events.length - 1; i >= 0 && found.size < calls.length; i--) {
      const e = events[i]!;
      if (e.kind === "assistant") for (const b of e.data.blocks as ToolUseBlock[]) if (b.type === "tool_use" && calls.includes(b.id)) found.set(b.id, b);
    }
    return calls.map((id) => found.get(id)).filter((u): u is ToolUseBlock => !!u);
  }, [calls, events]);
  if (!uses.length) return null;
  return <div className="mb-2 flex flex-col gap-2">{uses.map((u, i) => <Docked key={u.id} use={u} sessionId={sessionId} first={i === 0} />)}</div>;
}

// The docked card is held to the one rule of lib/asks.ts. The keyboard comes
// to the card itself, where nothing answers. What is typed there goes to the
// message box. A number is the card's only once the owner put the keyboard on
// it (their Tab, arrow or press, or the key that goes to what waits): then it
// picks an option, and on a card that is one question with one choice it
// answers with it, if that option is whole in view. Enter sends what is shown
// chosen. No key answers within the settle time of the keyboard arriving, by
// being held, or under a dialog.
function Docked({ use, sessionId, first }: { use: ToolUseBlock; sessionId: string; first: boolean }) {
  const qs = questions(use.name, use.input);
  const key = `${sessionId}:${use.id}`;
  const [picked, setPicked] = useState<Picked>(() => answerDrafts.get(key)?.picked ?? {});
  const [other, setOther] = useState<Record<string, string>>(() => answerDrafts.get(key)?.other ?? {});
  const [sending, setSending] = useState(false);
  const inflight = useRef(false);
  const [err, setErr] = useState("");
  const [nudge, setNudge] = useState("");
  const root = useRef<HTMLDivElement>(null);
  // The first question of a session takes the keyboard as it appears; one behind it waits its turn.
  const held = useAskKeys(root, first);
  const hold = useHold(root);
  useEffect(() => {
    if (Object.keys(picked).length || Object.values(other).some((t) => t)) answerDrafts.set(key, { picked, other });
  }, [key, picked, other]);
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

  const has = (p: Picked, q: UiQuestion) => (p[q.id]?.length ?? 0) > 0 || !!(other[q.id] ?? "").trim();
  const ready = qs.every((q) => has(picked, q));
  const toggled = (p: Picked, q: UiQuestion, label: string): Picked => {
    const cur = p[q.id] ?? [];
    return { ...p, [q.id]: q.multi ? (cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label]) : [label] };
  };
  // One answer per question card: Enter and the button share the guard while it is on its way.
  const submit = async (p: Picked = picked) => {
    if (inflight.current) return;
    inflight.current = true;
    held.current = !!root.current?.contains(document.activeElement);
    noteAnswer(use.id);
    setSending(true);
    setErr("");
    try {
      await actions.answer(sessionId, use.id, Object.fromEntries(qs.map((q) => [q.id, { picked: p[q.id] ?? [], other: other[q.id] }])));
    } catch (e) {
      setErr(failed(e, { at: "QuestionCard" }));
      setSending(false);
      inflight.current = false;
    }
  };
  // Sends, or says why not. `no`: why the key that asked may not answer now (lib/asks.ts).
  const send = (p: Picked = picked, no = "") => {
    if (no) return setNudge(no);
    if (!qs.every((q) => has(p, q))) return setNudge(qs.length > 1 ? "Choose an answer for each question first" : "Choose an answer or type one first");
    setNudge("");
    void submit(p);
  };

  // One number answers a card that is one question with one choice to make.
  const oneKey = qs.length === 1 && !qs[0]!.multi && qs[0]!.options.length > 0;
  const most = Math.min(9, Math.max(0, ...qs.map((q) => q.options.length)));
  const digits = most > 1 ? `1 to ${most}` : "1";
  // Numbers are the card's own only once the owner put the keyboard on it and it has been there for
  // the settle time. Until then a number typed here goes on to the message box with the rest of
  // what is typed (so that all of it gets there, or none), and no number is drawn on the options:
  // the card shows a key only while that key answers, and the hint says what the keys do now.
  const digitsOn = hold.own && hold.keys === "ready";
  const hint = !most ? "Tab goes to the field, Enter sends"
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
      const stops = [...e.currentTarget.querySelectorAll<HTMLElement>('[data-testid="question-option"], [data-testid="question-other"], [data-testid="question-submit"]:not(:disabled)')];
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
      if (t.dataset.testid === "question-submit") return; // the button's own press
      e.preventDefault();
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
      if (oneKey && el && inView(el)) void submit(next);
      else el?.scrollIntoView({ block: "nearest" });
      return;
    }
    // Anything else typed on the card is for the message box.
    typeToBox(e);
  };

  return (
    <div
      ref={root}
      tabIndex={-1}
      role="group"
      aria-label={`The agent is asking: ${qs[0]?.question ?? ""}`}
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
      <Head open answered={false} />
      <div className="flex flex-col gap-4 px-3.5 pt-3">
        {qs.map((q) => (
          <fieldset key={q.id} data-q={q.id} className="flex flex-col gap-2">
            <Legend q={q} />
            {q.options.length > 0 && (
              <div className="grid gap-1.5 sm:grid-cols-2" role={q.multi ? "group" : "radiogroup"}>
                {q.options.map((o, i) => {
                  const on = (picked[q.id] ?? NONE).includes(o.label);
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
                        "flex scroll-mb-14 items-start gap-2.5 rounded-md border px-3 py-2 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent/30",
                        on ? "border-accent bg-accent-soft" : "border-line bg-sunken hover:border-line-strong",
                      )}
                    >
                      {/* The key that picks it, drawn only while it does (the numbers are the card's). Else the
                          mark of a choice, in the same room: nothing moves when the numbers come. */}
                      {digitsOn && i < 9
                        ? <kbd aria-hidden="true" data-testid="question-digit" className="mt-px grid size-[1.125rem] shrink-0 place-items-center rounded-xs border border-line-strong bg-raised text-micro font-medium text-fg pointer-coarse:hidden">{i + 1}</kbd>
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
              value={other[q.id] ?? ""}
              onChange={(e) => setOther((o) => ({ ...o, [q.id]: e.target.value }))}
              disabled={sending}
              aria-label={q.options.length ? `Your own answer to: ${q.question}` : `Your answer to: ${q.question}`}
              placeholder={q.options.length ? "Or type your own answer" : "Type your answer"}
              data-testid="question-other"
              className="h-8 rounded-md border border-line bg-sunken px-3 text-ui outline-none placeholder:text-faint focus:border-accent"
            />
          </fieldset>
        ))}
        {/* Answer stays at the card's lower edge while a long question scrolls under it. */}
        <div className="sticky bottom-0 -mx-3.5 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-b-lg border-t border-line bg-raised px-3.5 py-2.5" data-testid="question-foot">
          <button
            type="button"
            disabled={!ready || sending}
            // A key on the button answers as Enter does: not as the keyboard arrives, not under a dialog.
            onClick={(e) => send(picked, e.detail === 0 ? keyRefused(e.currentTarget) : "")}
            data-testid="question-submit"
            className="h-8 rounded-md bg-accent px-3.5 text-ui font-medium text-accent-fg transition-opacity hover:bg-accent-hover disabled:opacity-40"
          >
            {sending ? "Sending" : "Answer"}
          </button>
          {err && <span className="text-caption text-danger" role="alert">{err}</span>}
          {/* Why a key did nothing, else what the keys do while the card has the keyboard. */}
          {nudge ? <span className="ml-auto text-micro text-warn" role="status" data-testid="question-nudge">{nudge}</span>
            : <span className={cn("invisible ml-auto text-micro text-faint max-sm:hidden pointer-coarse:hidden", hold.keys === "ready" && "group-focus-within/card:visible")} data-testid="question-hint">{hint}</span>}
        </div>
      </div>
    </div>
  );
}
