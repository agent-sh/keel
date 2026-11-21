// The work of a turn in the transcript: its tool calls as a rail of steps, a
// line each (lib/work.ts makes the steps and what each line says). A step of
// one call is that call's own line; a step of several opens to its calls. A
// call that failed or still runs shows under its step without opening it.
import { Collapsible } from "@base-ui/react/collapsible";
import { Brain, ChevronDown, ChevronRight } from "lucide-react";
import { memo, useEffect, useState, type KeyboardEvent, type MouseEvent } from "react";
import type { Row } from "../lib/rows.ts";
import { callsOf, callState, sentence, summarize, type Step, type StepSummary, type WorkItem } from "../lib/work.ts";
import { useUI } from "../lib/ui.ts";
import { Markdown } from "./Markdown.tsx";
import { Delta, ToolCall } from "./ToolCall.tsx";

export function Thinking({ text, live }: { text: string; live?: boolean }) {
  if (!text.trim() && !live) return null;
  return (
    <details className="group/think text-ui text-muted" open={live}>
      <summary className="inline-flex cursor-default list-none items-center gap-1.5 rounded-sm py-0.5 pr-1 select-none hover:text-fg">
        <Brain className="size-3.5" />
        <span className={live ? "animate-pulse-dot" : ""}>{live ? "Thinking" : "Thought"}</span>
        {!live && <ChevronDown className="size-3 -rotate-90 transition-transform group-open/think:rotate-0" />}
      </summary>
      {text.trim() && <div className="mt-1.5 max-h-96 overflow-y-auto border-l-2 border-line pl-3.5 text-base leading-relaxed whitespace-pre-wrap">{text}</div>}
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
  const all = [...(at.closest(".k-transcript") ?? document).querySelectorAll<HTMLElement>(".k-line")];
  const to = all[all.indexOf(at) + (e.key === "ArrowDown" ? 1 : -1)];
  if (!to) return;
  e.preventDefault();
  to.focus();
}

const ROLE_VERB: Record<string, [string, string]> = {
  Explored: ["Exploring", "Explored"], Read: ["Reading", "Read"], Searched: ["Searching", "Searched"], Listed: ["Listing", "Listed"],
  "Searched the web": ["Searching the web", "Searched the web"], Fetched: ["Fetching", "Fetched"], Edited: ["Editing", "Edited"], Wrote: ["Writing", "Wrote"],
  Ran: ["Running", "Ran"], Used: ["Using", "Used"],
};

function SummaryWords({ s }: { s: StepSummary }) {
  return (
    <>
      <span className="k-line-verb">{s.running ? ROLE_VERB[s.label]?.[0] ?? s.label : s.label}</span>
      {s.counts && <span className="k-line-count">{s.counts}</span>}
      <span className="k-line-what" data-words={s.code ? undefined : ""}>
        {s.targets.map((t, i) => <span key={i} className="k-line-target">{t}</span>)}
        {s.more > 0 && <span className="k-line-rest">+{s.more}</span>}
      </span>
    </>
  );
}

const Lead = ({ items, sid }: { items: WorkItem[]; sid: string }) => (
  <>
    {items.map((i) => (i.t === "thought" ? <Thinking key={i.id} text={i.text} /> : i.t === "note" ? <div key={i.id} className="k-aside"><Markdown text={i.text} sessionId={sid} /></div> : null))}
  </>
);

const StepView = memo(function StepView({ step, sid, cwd, remote, all }: { step: Step; sid: string; cwd?: string; remote: boolean; all: All }) {
  const calls = callsOf(step);
  const s = summarize(step);
  const [open, setOpen] = useState(false);
  useEffect(() => { if (all.n) setOpen(all.open); }, [all]);
  // A search hit inside a folded step opens it; the call's own line takes it from there.
  const hit = useUI((u) => !!u.focusCall && calls.some((c) => c.id === u.focusCall));
  useEffect(() => { if (hit) setOpen(true); }, [hit]);
  const events = [...new Set(step.items.map((i) => i.event))].join(" ");
  // What the model said on the way is on the page; what it thought opens with the step.
  const notes = step.items.filter((i) => i.t === "note");
  const thoughts = step.items.filter((i) => i.t === "thought");
  const said = notes.map((n) => <div key={n.id} className="k-aside" data-testid="assistant-text"><Markdown text={n.text} sessionId={remote ? undefined : sid} /></div>);
  if (!calls.length) return <div className="k-step" data-events={events}>{said}{thoughts.length > 0 && <div className="k-step-lead"><Lead items={thoughts} sid={sid} /></div>}</div>;
  if (calls.length === 1) {
    const c = calls[0]!;
    return (
      <div className="k-step" data-events={events} data-state={callState(c.result)}>
        {said}
        <ToolCall use={c.use} result={c.result} sessionId={sid} cwd={cwd} lead={thoughts.length ? <Lead items={thoughts} sid={sid} /> : undefined} />
      </div>
    );
  }
  const state = s.running ? "running" : s.failed ? "error" : "ok";
  // Closed, a step still shows the calls that need a look: the one that runs, the ones that failed.
  const peek = open ? [] : calls.filter((c) => { const st = callState(c.result); return st === "running" || st === "error"; });
  return (
    <div className="k-step" data-events={events} data-state={state}>
      {said}
      <Collapsible.Root open={open} onOpenChange={setOpen} data-testid="work-step" data-family={step.family} data-state={state} data-calls={calls.length}>
        <Collapsible.Trigger className="k-line" data-all="" aria-label={sentence(s)}>
          <SummaryWords s={s} />
          <span className="k-line-end">
            {(s.added > 0 || s.removed > 0) && <Delta added={s.added} removed={s.removed} />}
            {s.running > 0 && <span className="k-line-run" aria-hidden="true" />}
            {s.failed > 0 && <span className="text-danger" data-testid="step-failed">{s.failed === s.calls ? "failed" : `${s.failed} failed`}</span>}
            {s.stopped > 0 && !s.failed && <span className="text-warn">stopped</span>}
            <ChevronRight className="k-line-chev" />
          </span>
        </Collapsible.Trigger>
        {peek.length > 0 && (
          <div className="k-step-calls" data-testid="step-peek">
            {peek.slice(0, 3).map((c) => <ToolCall key={c.id} use={c.use} result={c.result} sessionId={sid} cwd={cwd} />)}
            {peek.length > 3 && <p className="k-line-why">and {peek.length - 3} more failed</p>}
          </div>
        )}
        <Collapsible.Panel className="k-tool-panel overflow-hidden">
          <div className="k-step-calls">
            {step.items.map((i) => (i.t === "call" ? <ToolCall key={i.id} use={i.use} result={i.result} sessionId={sid} cwd={cwd} /> : i.t === "thought" ? <Thinking key={i.id} text={i.text} /> : null))}
          </div>
        </Collapsible.Panel>
      </Collapsible.Root>
    </div>
  );
});

// A run of tool calls: one rail. Shift with a click or a key on a step's line opens or closes every step of the run.
export function Work({ row, sid, cwd, remote }: { row: Row; sid: string; cwd?: string; remote: boolean }) {
  const [all, setAll] = useState<All>({ n: 0, open: false });
  const onAll = (e: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>) => {
    const line = (e.target as HTMLElement).closest<HTMLElement>(".k-line[data-all]");
    if (!line || !e.shiftKey || ("key" in e && e.key !== "Enter" && e.key !== " ")) return;
    e.preventDefault();
    setAll((a) => ({ n: a.n + 1, open: line.getAttribute("aria-expanded") !== "true" }));
  };
  return (
    <div id={`e-${row.e.id}`} data-event-id={row.e.id} className="k-work row-cv" data-testid="work" role="group" aria-label="What the model did" onClickCapture={onAll} onKeyDownCapture={onAll} onKeyDown={lineKeys}>
      {row.steps!.map((st) => <StepView key={st.key} step={st} sid={sid} cwd={cwd} remote={remote} all={all} />)}
    </div>
  );
}

// The line of a call whose input is still being written: a rail of its own under the reply so far.
export function LiveWork({ children }: { children: React.ReactNode }) {
  return <div className="k-work" data-testid="work-live"><div className="k-step" data-state="running">{children}</div></div>;
}
