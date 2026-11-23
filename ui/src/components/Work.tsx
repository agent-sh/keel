// The work of a turn in the transcript: its tool calls as a rail of steps, a
// line each (lib/work.ts makes the steps and what each line says). A step of
// one call is that call's own line; a step of several opens to its calls.
// What needs a look shows under a closed step: a call that runs, waits,
// failed or was cut, and every call the daemon marks (lib/marks.ts), each on
// a line of its own, so nothing that matters is behind "+N".
import { Collapsible } from "@base-ui/react/collapsible";
import { Brain, ChevronDown } from "lucide-react";
import { Fragment, memo, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import type { Row } from "../lib/rows.ts";
import { useBlocked } from "../lib/blocked.ts";
import { useCallsLive } from "../lib/call-live.ts";
import { marksOf, useMarked } from "../lib/marks.ts";
import { callHeld, callKey, drop, letGo, thoughtHeld, thoughtKey, thoughtLive, useHeld, useLetGoUnseen } from "../lib/held.ts";
import { resultText, splitDiagnostics, toolKind } from "../lib/tools.ts";
import { besideOf, callsOf, carriedOut, edgeOf, isTable, lookOf, sentence, stateWords, summarize, type Live, type Step, type StepSummary, type WorkItem } from "../lib/work.ts";
import { useUI } from "../lib/ui.ts";
import { Markdown } from "./Markdown.tsx";
import { Delta, hookOf, ToolCall } from "./ToolCall.tsx";
import { isLive, useAuto } from "../lib/automation.ts";
import { useToldStates } from "../lib/watch.ts";
import { agentSaid } from "./automation/bits.tsx";
import { countWord } from "../../../src/core/state-words.ts";

export function Thinking({ text, live }: { text: string; live?: boolean }) {
  // What was thought stays open when the thinking ends, as the reader had it, until it has left the
  // view (lib/held.ts): folding it then would drop every line under it.
  useHeld();
  if (live) thoughtLive(text);
  const held = !live && thoughtHeld(text);
  const box = useRef<HTMLDetailsElement>(null);
  useLetGoUnseen(box, thoughtKey(text), held);
  if (!text.trim() && !live) return null;
  return (
    <details ref={box} className="group/think text-ui text-muted" open={live || held} data-testid="thinking" data-held={held ? "" : undefined} onToggle={(e) => { if (held && !e.currentTarget.open) letGo(thoughtKey(text)); }}>
      <summary className="inline-flex cursor-default list-none items-center gap-1.5 rounded-sm py-0.5 pr-1 select-none hover:text-fg">
        <Brain className="size-3.5" />
        <span className={live ? "animate-pulse-dot" : ""}>{live ? "Thinking" : "Thought"}</span>
        {!live && <ChevronDown className="size-3 -rotate-90 transition-transform group-open/think:rotate-0" />}
      </summary>
      {text.trim() && <div className="k-quote mt-1.5 max-h-96 overflow-y-auto text-base leading-relaxed whitespace-pre-wrap">{text}</div>}
    </details>
  );
}

// Every step of a run opened or closed together (Shift with the click or the key): `n` counts the asks.
type All = { n: number; open: boolean };

// The keys of a line on the rail: Right opens it, Left closes it, Up and Down
// go to the line before and after it in the conversation.
function lineKeys(e: KeyboardEvent<HTMLElement>) {
  const at = (e.target as HTMLElement).closest<HTMLElement>(".k-line");
  if (!at || e.ctrlKey || e.metaKey || e.altKey) return;
  const open = at.getAttribute("aria-expanded") === "true";
  if ((e.key === "ArrowRight" && !open) || (e.key === "ArrowLeft" && open)) { e.preventDefault(); at.click(); return; }
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  // (Every line that takes the keyboard: one that only says something, a question that waits, is passed over.)
  const all = [...(at.closest(".k-transcript") ?? document).querySelectorAll<HTMLElement>("button.k-line")];
  const to = all[all.indexOf(at) + (e.key === "ArrowDown" ? 1 : -1)];
  if (!to) return;
  e.preventDefault();
  to.focus();
}

// A step's verb while a call of it still runs, and for a step none of whose calls was carried out.
const RUNNING: Record<string, string> = {
  Explored: "Exploring", Read: "Reading", Searched: "Searching", Listed: "Listing", "Searched the web": "Searching the web", Fetched: "Fetching",
  Edited: "Editing", Wrote: "Writing", Ran: "Running", Used: "Using",
};
const PLAIN: Record<string, string> = {
  Explored: "Explore", Read: "Read", Searched: "Search", Listed: "List", "Searched the web": "Web search", Fetched: "Fetch",
  Edited: "Edit", Wrote: "Write", Ran: "Run", Used: "Use",
};

// A mark on a closed line: the model thought on the way to it, and what it thought opens with the line.
export const ThoughtMark = () => <Brain className="k-line-thought" role="img" aria-label="Holds what the model thought" data-testid="thought-mark" />;

// The targets of a line, told apart by a hairline on the page and by a comma in a copied selection.
export function Targets({ list }: { list: string[] }) {
  return <>{list.map((t, i) => <Fragment key={i}>{i > 0 && <span className="k-sep">, </span>}<span className="k-line-target">{t}</span></Fragment>)}</>;
}

// What a step did: its verb, how much, how it stands, and to what. Every target named is whole on the page
// (the line takes another row for them), and "+N" is exactly what is not named.
function StepLine({ s, words }: { s: StepSummary; words: ReturnType<typeof stateWords> }) {
  return (
    <span className="k-line-text" data-wrap="">
      <span className="k-line-verb">{s.looks.running ? RUNNING[s.label] ?? s.label : carriedOut(s) ? s.label : PLAIN[s.label] ?? s.label}</span>{" "}
      {s.counts && <><span className="k-line-count">{s.counts}</span>{" "}</>}
      {words.map((w) => <Fragment key={w.text}><span className="k-line-state" data-tone={w.tone} data-testid="step-state">{w.text}</span>{" "}</Fragment>)}
      <span className="k-line-what" data-words={s.code ? undefined : ""}><Targets list={s.targets} /></span>
      {s.more > 0 && <>{" "}<span className="k-line-rest" data-more="">+{s.more} more</span></>}
    </span>
  );
}

const Thoughts = ({ items }: { items: WorkItem[] }) => <>{items.map((i) => (i.t === "thought" ? <Thinking key={i.id} text={i.text} /> : null))}</>;

// What shows of a closed step's calls, each on a line of its own: every one that waits, was turned away, was
// cut or is marked, every change a language server found something in, and the first few that run or failed
// (the rest are counted, by what they are). Calls marked for the same reason stand together under that
// reason, said once.
const PEEK = 3;
type Call = ReturnType<typeof callsOf>[number];
// `held`: the calls that ran on this page and stay as they stood until they leave the view: a
// command's open card stays; of the others, the last one keeps its line until another line takes
// its place, a call that runs or the step after this one (`end`: there is none), so the run never
// gets shorter while it is read.
function peekOf(calls: Call[], live: Live, marks: (id: string) => string, held: ReadonlySet<string>, end: boolean) {
  const alone: Call[] = [];
  const groups = new Map<string, Call[]>();
  let running = 0, failed = 0;
  let last: Call | undefined;
  for (const c of calls) {
    const look = lookOf(c, live);
    const why = marks(c.id);
    if (why && (look === "ok" || look === "unfinished")) groups.set(why, [...(groups.get(why) ?? []), c]);
    else if (why || look === "waiting" || look === "cut" || look === "denied" || look === "refused" || found(c)) alone.push(c);
    else if (look === "running") { if (running++ < PEEK) alone.push(c); }
    else if (look === "error") { if (failed++ < PEEK) alone.push(c); }
    else if (held.has(c.id)) { if (toolKind(c.use.name) === "shell") alone.push(c); else { if (last) drop(callKey(last.id)); last = c; } }
  }
  if (last) { if (running || !end) drop(callKey(last.id)); else alone.push(last); }
  // A reason only one call has is said on that call's own line.
  const same: { why: string; calls: Call[] }[] = [];
  for (const [why, list] of groups) { if (list.length > 1) same.push({ why, calls: list }); else alone.push(list[0]!); }
  const order = new Map(calls.map((c, i) => [c.id, i]));
  alone.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  return { alone, same, running: Math.max(0, running - PEEK), failed: Math.max(0, failed - PEEK) };
}
// A change whose result carries what a language server found after it.
const found = (c: Call) => { const t = c.result ? resultText(c.result) : ""; return t.includes("<diagnostics server=") && splitDiagnostics(t).diagnostics.some((d) => d.lines.length > 0); };

// `table`: the run is set as a table, so a few words stand beside this step's line.
// `end`: the last step of its run (a step with one after it gave its place to that one's line).
const StepView = memo(function StepView({ step, sid, cwd, remote, all, table, end }: { step: Step; sid: string; cwd?: string; remote: boolean; all: All; table: boolean; end: boolean }) {
  const calls = callsOf(step);
  const { working, waiting } = useCallsLive(sid, calls);
  const marked = useMarked(sid, calls);
  const blocked = useBlocked(sid);
  // What the page knows of the step's calls beyond their records: which wait on a card, which were refused.
  const live: Live = useMemo(() => {
    const mine = new Set(calls.map((c) => c.id));
    const refused = new Set(blocked.flatMap((b) => b.calls ?? []).filter((id) => mine.has(id)));
    return { working, waiting: new Set(waiting.split(" ").filter(Boolean)), refused, cwd };
  }, [working, waiting, blocked, cwd, step]);
  // Why a call is marked, in the daemon's few words, or by a hook of the owner's (that rides with its result).
  const markOf = useMemo(() => {
    const by = new Map<string, string>();
    for (const c of calls) {
      const words = [...(marked.includes(c.id) ? marksOf(sid, c.id).filter((m) => m.kind !== "denied").map((m) => m.short) : []), ...(hookOf(c.result) ? [hookOf(c.result)!.input !== undefined ? "changed by a hook" : "allowed by a hook"] : [])];
      if (words.length) by.set(c.id, words.join(", "));
    }
    return (id: string) => by.get(id) ?? "";
  }, [marked, step, sid]);
  const [open, setOpen] = useState(false);
  useEffect(() => { if (all.n) setOpen(all.open); }, [all]);
  // What ran on this page and is held as it stood (lib/held.ts).
  useHeld();
  const held = new Set(calls.filter((c) => callHeld(c.id, !c.result && live.working && !live.waiting?.has(c.id))).map((c) => c.id));
  // A search hit inside a folded step opens it; the call's own line takes it from there.
  const hit = useUI((u) => !!u.focusCall && calls.some((c) => c.id === u.focusCall));
  useEffect(() => { if (hit) setOpen(true); }, [hit]);
  const events = [...new Set(step.items.map((i) => i.event))].join(" ");
  // What the model said on the way is on the page: a few words beside the line, more above it.
  const beside = table ? besideOf(step) : undefined;
  const said: ReactNode[] = step.items.filter((i) => i.t === "note").map((n) => (
    <div key={n.id} className={n === beside ? "k-aside k-said" : "k-aside"} data-testid="assistant-text"><Markdown text={(n as { text: string }).text} sessionId={remote ? undefined : sid} /></div>
  ));
  const thoughts = step.items.filter((i) => i.t === "thought");
  // What the model thought, open as it streamed, stays on the page above the step until it has left the view.
  const stillOpen = thoughts.filter((i) => thoughtHeld((i as { text: string }).text));
  const leadHeld = stillOpen.length > 0 && <div className="k-step-lead"><Thoughts items={stillOpen} /></div>;
  if (!calls.length) return <div className="k-step" data-events={events}>{said}{thoughts.length > 0 && <div className="k-step-lead"><Thoughts items={thoughts} /></div>}</div>;
  if (step.family === "agents" && calls.length > 1) return <AgentsStep step={step} sid={sid} cwd={cwd} remote={remote} events={events} live={live} all={all} />;
  if (calls.length === 1) {
    const c = calls[0]!;
    const one = summarize(step, live);
    // A card of its own (an agent, a question, code, readers) has what the model thought on the rail above it.
    const card = step.family === "card" || step.family === "agents";
    // (A question that waits is the owner's: its part of the rail says so, not that something runs.)
    const edge = card && toolKind(c.use.name) === "ask" && !c.result ? "need" : edgeOf(one.looks, one.soft);
    return (
      <div className="k-step" data-events={events} data-state={edge}>
        {said}
        <div className="k-did">
          {card ? thoughts.length > 0 && <div className="k-step-lead"><Thoughts items={thoughts} /></div> : leadHeld}
          <ToolCall use={c.use} result={c.result} sessionId={sid} cwd={cwd} event={c.event} auto lead={!card && thoughts.length ? <Thoughts items={thoughts} /> : undefined} />
        </div>
      </div>
    );
  }
  const peek = open ? null : peekOf(calls, live, markOf, held, end);
  // Closed, the line names what has no line of its own under it; opened, every call is under it.
  const s = summarize(step, peek ? { ...live, own: new Set([...peek.alone, ...peek.same.flatMap((g) => g.calls)].map((c) => c.id)) } : live);
  const edge = edgeOf(s.looks, s.soft);
  const words = stateWords(s);
  return (
    <div className="k-step" data-events={events} data-state={edge}>
      {said}
      <div className="k-did">
        {leadHeld}
        <Collapsible.Root open={open} onOpenChange={setOpen} data-testid="work-step" data-family={step.family} data-state={edge} data-calls={calls.length}>
          <Collapsible.Trigger className="k-line" data-all="" data-step="" aria-label={sentence(s, words)}>
            <StepLine s={s} words={words} />
            <span className="k-line-end">
              {s.thoughts > 0 && <ThoughtMark />}
              {(s.added > 0 || s.removed > 0) && <Delta added={s.added} removed={s.removed} />}
              {s.looks.running > 0 && <span className="k-line-run" aria-hidden="true" />}
            </span>
          </Collapsible.Trigger>
          {peek && (peek.alone.length > 0 || peek.same.length > 0 || peek.running > 0 || peek.failed > 0) && (
            <div className="k-step-calls" data-testid="step-peek">
              {/* The reason once, the calls it is said of under it. */}
              {peek.same.map((g) => (
                <div key={g.why} className="k-peek-same" data-testid="peek-same">
                  <p className="k-peek-why"><span className="k-line-count">{g.calls.length} calls</span><span className="k-line-state k-line-mark" data-tone="warn" data-testid="call-mark">{g.why}</span></p>
                  {g.calls.map((c) => <ToolCall key={c.id} use={c.use} result={c.result} sessionId={sid} cwd={cwd} peek auto quiet />)}
                </div>
              ))}
              {/* A copy of the call while the step is closed: a search hit is taken by the call itself, once the step opens. */}
              {peek.alone.map((c) => <ToolCall key={c.id} use={c.use} result={c.result} sessionId={sid} cwd={cwd} peek auto />)}
              {peek.running > 0 && <p className="k-line-more" data-testid="peek-more">and {peek.running} more running</p>}
              {peek.failed > 0 && <p className="k-line-more" data-tone={s.soft ? "note" : "fail"} data-testid="peek-more">and {peek.failed} more failed</p>}
            </div>
          )}
          <Collapsible.Panel className="k-tool-panel overflow-hidden">
            <div className="k-step-calls">
              {step.items.map((i) => (i.t === "call" ? <ToolCall key={i.id} use={i.use} result={i.result} sessionId={sid} cwd={cwd} /> : i.t === "thought" ? <Thinking key={i.id} text={i.text} /> : null))}
            </div>
          </Collapsible.Panel>
        </Collapsible.Root>
      </div>
    </div>
  );
});

// Agents started together, one after another: one line ("Started 12 agents" and the first tasks), which
// opens to each agent's own line with the few words the model said before it. Closed, the agents that call
// the owner stand under it, each on its own line (one that needs them, one that failed); how the others
// stand is the agents' line under the session's row and their own rows, so the conversation does not
// change with each of them.
function AgentsStep({ step, sid, cwd, remote, events, live, all }: { step: Step; sid: string; cwd?: string; remote: boolean; events: string; live: Live; all: All }) {
  const calls = callsOf(step);
  const [open, setOpen] = useState(false);
  useEffect(() => { if (all.n) setOpen(all.open); }, [all]);
  const hit = useUI((u) => !!u.focusCall && calls.some((c) => c.id === u.focusCall));
  useEffect(() => { if (hit) setOpen(true); }, [hit]);
  const agents = useAuto((x) => x.agents);
  const told = useToldStates();
  // Each call's agent: the one recorded with the call's id (never a guess by title).
  const byCall = useMemo(() => new Map(Object.values(agents).filter((a) => a.parent_id === sid && a.call_id).map((a) => [a.call_id!, a])), [agents, sid]);
  const calling = calls.filter((c) => { const a = byCall.get(c.id); const w = a ? agentSaid(a, told[a.session_id]).watch : undefined; return w === "need" || w === "fail" || w === "declined"; });
  const asking = calling.filter((c) => { const a = byCall.get(c.id)!; return agentSaid(a, told[a.session_id]).watch === "need"; }).length;
  const failed = calling.length - asking;
  const s = summarize(step, live);
  const running = calls.some((c) => { const a = byCall.get(c.id); return a ? isLive(a) : !c.result; });
  const words: ReturnType<typeof stateWords> = [...(asking ? [{ text: countWord("need", asking), tone: "need" as const }] : []), ...(failed ? [{ text: countWord("fail", failed), tone: "fail" as const }] : [])];
  const edge = asking ? "need" : failed ? "error" : running ? "running" : "ok";
  return (
    <div className="k-step" data-events={events} data-state={edge}>
      <div className="k-did">
        <Collapsible.Root open={open} onOpenChange={setOpen} data-testid="work-step" data-family="agents" data-state={edge} data-calls={calls.length}>
          <Collapsible.Trigger className="k-line" data-all="" data-step="" aria-label={sentence(s, words)}>
            <StepLine s={s} words={words} />
            <span className="k-line-end">{running && <span className="k-line-run" aria-hidden="true" />}</span>
          </Collapsible.Trigger>
          {!open && calling.length > 0 && (
            <div className="k-step-calls" data-testid="step-peek">
              {calling.map((c) => <ToolCall key={c.id} use={c.use} result={c.result} sessionId={sid} cwd={cwd} peek auto />)}
            </div>
          )}
          <Collapsible.Panel className="k-tool-panel overflow-hidden">
            <div className="k-step-calls">
              {step.items.map((i) => (i.t === "call" ? <ToolCall key={i.id} use={i.use} result={i.result} sessionId={sid} cwd={cwd} /> : i.t === "thought" ? <Thinking key={i.id} text={i.text} /> : <div key={i.id} className="k-aside" data-testid="assistant-text"><Markdown text={i.text} sessionId={remote ? undefined : sid} /></div>))}
            </div>
          </Collapsible.Panel>
        </Collapsible.Root>
      </div>
    </div>
  );
}

// A run of tool calls: one rail. Shift with a click or a key on a step's line opens or closes every step of the run.
export function Work({ row, sid, cwd, remote }: { row: Row; sid: string; cwd?: string; remote: boolean }) {
  const [all, setAll] = useState<All>({ n: 0, open: false });
  const onAll = (e: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>) => {
    const line = (e.target as HTMLElement).closest<HTMLElement>(".k-line[data-all]");
    if (!line || !e.shiftKey || ("key" in e && e.key !== "Enter" && e.key !== " ")) return;
    e.preventDefault();
    setAll((a) => ({ n: a.n + 1, open: line.getAttribute("aria-expanded") !== "true" }));
  };
  const table = isTable(row.steps!);
  return (
    <div className="k-work row-cv" data-testid="work" data-run={row.id} data-said={table ? "" : undefined} role="group" aria-label="What the model did" onClickCapture={onAll} onKeyDownCapture={onAll} onKeyDown={lineKeys}>
      {row.steps!.map((st, i) => <StepView key={st.key} step={st} sid={sid} cwd={cwd} remote={remote} all={all} table={table} end={i === row.steps!.length - 1} />)}
    </div>
  );
}

// The line of a call whose input is still being written: a rail of its own under the reply so far.
export function LiveWork({ children }: { children: ReactNode }) {
  return <div className="k-work" data-testid="work-live"><div className="k-step" data-state="running"><div className="k-did">{children}</div></div></div>;
}
