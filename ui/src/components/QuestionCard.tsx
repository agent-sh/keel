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
import { useAskKeys } from "../lib/asks.ts";
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
  const none = useRef<HTMLElement>(null);
  // The first question of a session takes the keyboard when it opens; one behind it waits its turn.
  const { ripe, held } = useAskKeys(root, first ? root : none);
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
  // One answer per question card: Enter, a number and the button share the guard while it is on its way.
  const submit = async (p: Picked = picked) => {
    if (inflight.current) return;
    inflight.current = true;
    held.current = !!root.current?.contains(document.activeElement);
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
  // Says why when it does nothing. A key pressed on the card itself acts only once the card
  // has stood for the settle time (`settled`): it may have been on its way to the message
  // box when the card took the keyboard. A press on the button, and Enter in the card's own
  // field, are made on the card: they need no wait.
  const send = (p: Picked = picked, settled = true) => {
    if (!settled) return setNudge("Not yet: it has only just arrived");
    if (!qs.every((q) => has(p, q))) return setNudge(qs.length > 1 ? "Choose an answer for each question first" : "Choose an answer or type one first");
    setNudge("");
    void submit(p);
  };

  // One number answers a card that is one question with one choice to make.
  const oneKey = qs.length === 1 && !qs[0]!.multi && qs[0]!.options.length > 0;
  const most = Math.min(9, Math.max(0, ...qs.map((q) => q.options.length)));
  const keys = most > 1 ? `1 to ${most}` : "1";
  const hint = oneKey ? `Press ${keys} to answer, or type your own` : most > 0 ? `Press ${keys} to choose, Enter to send` : "Type your answer, Enter to send";

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey || composing(e) || sending) return;
    const t = e.target as HTMLElement;
    const field = t.tagName === "INPUT";
    // The question the key is for: the one the keyboard is in, else the first that has no answer yet.
    const at = t.closest<HTMLElement>("fieldset[data-q]")?.dataset.q;
    const q = qs.find((x) => x.id === at) ?? qs.find((x) => !has(picked, x)) ?? qs[0];
    if (e.key === "Enter") {
      if (t.dataset.testid === "question-submit") return; // the button's own press
      e.preventDefault();
      if (e.repeat) return;
      // On an option of a single choice, Enter takes it and sends; elsewhere it sends what is chosen.
      const label = t.closest<HTMLElement>('[data-testid="question-option"]')?.dataset.label;
      const own = qs.find((x) => x.id === at);
      const next = label !== undefined && own && !own.multi ? toggled(picked, own, label) : picked;
      if (next !== picked) setPicked(next);
      return send(next, field || ripe);
    }
    if (field || !q) return;
    if (/^[1-9]$/.test(e.key) && !e.shiftKey) {
      const o = q.options[Number(e.key) - 1];
      if (!o) return;
      e.preventDefault();
      if (e.repeat) return;
      if (!ripe) return setNudge("Not yet: it has only just arrived");
      const next = toggled(picked, q, o.label);
      setPicked(next);
      setNudge("");
      if (oneKey) void submit(next);
      return;
    }
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !e.shiftKey) {
      const stops = [...e.currentTarget.querySelectorAll<HTMLElement>('[data-testid="question-option"], [data-testid="question-other"], [data-testid="question-submit"]:not(:disabled)')];
      const i = stops.indexOf(t);
      const to = i < 0 ? (e.key === "ArrowDown" ? stops[0] : stops.at(-1)) : stops[i + (e.key === "ArrowDown" ? 1 : -1)];
      if (!to) return;
      e.preventDefault();
      to.focus();
      return;
    }
    // Words typed while the card has the keyboard are the owner's own answer: they go to that field.
    if (e.key.length === 1 && e.key !== " ") e.currentTarget.querySelector<HTMLElement>(`fieldset[data-q="${CSS.escape(q.id)}"] [data-testid="question-other"]`)?.focus({ preventScroll: true });
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
      data-ask=""
      data-live={ripe || undefined}
      onKeyDown={onKeyDown}
    >
      <Head open answered={false} />
      <div className="flex flex-col gap-4 px-3.5 py-3">
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
                      className={cn(
                        "flex items-start gap-2.5 rounded-md border px-3 py-2 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent/30",
                        on ? "border-accent bg-accent-soft" : "border-line bg-sunken hover:border-line-strong",
                      )}
                    >
                      {/* The key that picks it, shown where a keyboard is used. */}
                      {i < 9 && <kbd aria-hidden="true" className="mt-px grid h-[1.125rem] min-w-[1.125rem] shrink-0 place-items-center rounded-xs border border-line bg-raised px-1 text-micro font-medium text-faint group-focus-within/card:border-line-strong group-focus-within/card:text-fg pointer-coarse:hidden">{i + 1}</kbd>}
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
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <button
            type="button"
            disabled={!ready || sending}
            onClick={() => send()}
            data-testid="question-submit"
            className="h-8 rounded-md bg-accent px-3.5 text-ui font-medium text-accent-fg transition-opacity hover:bg-accent-hover disabled:opacity-40"
          >
            {sending ? "Sending" : "Answer"}
          </button>
          {err && <span className="text-caption text-danger" role="alert">{err}</span>}
          {/* Why a key did nothing, else what the keys do while the card has the keyboard. */}
          {nudge ? <span className="ml-auto text-micro text-warn" role="status" data-testid="question-nudge">{nudge}</span>
            : <span className={cn("invisible ml-auto text-micro text-faint max-sm:hidden pointer-coarse:hidden", ripe && "group-focus-within/card:visible")} data-testid="question-hint">{hint}</span>}
        </div>
      </div>
    </div>
  );
}
