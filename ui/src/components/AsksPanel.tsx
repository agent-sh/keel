// Your asks: what the owner asked for in this session, newest first, each with its state from facts
// (src/board/asks.ts): the agents its turn started or whose task quotes it, and what the work board says of
// their branches. A quiet list: his words and one word of state; the agents, the time and why the state is
// what it is open under the row.
import { ChevronRight, CornerDownRight } from "lucide-react";
import { useMemo, useState } from "react";
import type { Session } from "../../../src/core/types.ts";
import { ASK_WHY, ASK_WORDS, askState, type AgentLine, type AskState } from "../../../src/board/asks.ts";
import { openSession } from "../lib/automation.ts";
import { useBoard } from "../lib/board.ts";
import { askLine, useAsks, type Ask } from "../lib/asks-list.ts";
import { savePref } from "../lib/ui.ts";
import { cn, when } from "../lib/utils.ts";

// What is settled: what runs holds it, or its agents reported with no branch to land. A reply with no work tied to it stays open: it is the ask most easily left behind.
const SETTLED: ReadonlySet<AskState> = new Set(["running", "reported"]);
const HOW: Record<Ask["how"], string> = { prompt: "Asked", steer: "Steered", queued: "Sent to the queue", voice: "Said", cli: "Sent from the command line", answer: "Answered on a card" };


function StateWord({ state }: { state: AskState }) {
  return (
    <span className={cn("k-myask-state", state === "stopped" ? "text-st-need" : "text-muted")} data-state={state} title={ASK_WHY[state]}>
      {state === "working" && <span className="size-1.5 rounded-full bg-st-work animate-pulse-dot" aria-hidden />}
      {ASK_WORDS[state]}
    </span>
  );
}

// To the message in the conversation, when the page holds it.
function toMessage(id: string) {
  const el = document.getElementById(`e-${id}`);
  if (!el) return false;
  if (matchMedia("(max-width: 1023px)").matches) savePref("panel", null);
  requestAnimationFrame(() => {
    el.scrollIntoView({ block: "center" });
    el.classList.remove("flash");
    void el.offsetWidth;
    el.classList.add("flash");
  });
  return true;
}

function Row({ a, state, agents, unknown }: { a: Ask; state: AskState; agents: AgentLine[]; unknown: number }) {
  const [open, setOpen] = useState(false);
  const [whole, setWhole] = useState(false);
  const [far, setFar] = useState(false);
  const line = askLine(a.text);
  const more = a.more || line.length < a.text.replace(/\s+/g, " ").trim().length;
  return (
    <li className="k-myask" data-testid="ask-row" data-state={state} data-open={open || undefined}>
      <button type="button" className="k-myask-head" aria-expanded={open} onClick={() => setOpen(!open)} title={`${HOW[a.how]} ${when(a.at)}`} data-testid="ask-toggle">
        <ChevronRight className="k-myask-chev" aria-hidden />
        <span className="k-myask-words" data-testid="ask-words">{line}</span>
        <StateWord state={state} />
      </button>
      {open && (
        <div className="k-myask-body" data-testid="ask-body">
          <p className="text-caption text-faint">
            {HOW[a.how]} {when(a.at)} · {ASK_WHY[state]}
          </p>
          {more && (whole
            ? <p className="k-myask-whole" data-testid="ask-whole">{a.text}{a.more ? "…" : ""}</p>
            : <button type="button" className="k-myask-link" onClick={() => setWhole(true)}>All the words</button>)}
          {agents.length > 0 && (
            <ul className="flex flex-col" data-testid="ask-agents">
              {agents.map((g) => (
                <li key={g.id}>
                  <button type="button" className="k-myask-agent" onClick={() => openSession(g.session_id)} title={g.branch ? `Branch ${g.branch}. Open the agent's session` : "Open the agent's session"} data-testid="ask-agent" data-state={g.state}>
                    <CornerDownRight className="size-3.5 shrink-0 text-faint" aria-hidden />
                    <span className="min-w-0 flex-1 truncate">{g.title}</span>
                    <StateWord state={g.state} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {unknown > 0 && <p className="text-caption text-faint" data-testid="ask-unknown">{unknown === 1 ? "1 agent of it is" : `${unknown} agents of it are`} not on the work board: {unknown === 1 ? "its" : "their"} state is not known.</p>}
          {far
            ? <p className="text-caption text-faint">The message is earlier than the conversation shows now: scroll up to it.</p>
            : <button type="button" className="k-myask-link" onClick={() => setFar(!toMessage(a.id))} data-testid="ask-to-message">Go to the message</button>}
        </div>
      )}
    </li>
  );
}

export function AsksPanel({ session }: { session: Session }) {
  const { asks, err } = useAsks(session.id);
  const board = useBoard(session.id);
  const [all, setAll] = useState(false);
  const rows = useMemo(() => (asks ?? []).map((a) => ({ a, ...askState(a, board?.rows ?? []) })), [asks, board]);
  // (Nothing until the board is read too: a tie whose agent has no row yet would read as no agent.)
  if (!asks || !board) return <p className="k-empty px-3 py-4">{err || "Loading…"}</p>;
  const open = rows.filter((r) => !SETTLED.has(r.state));
  const settled = rows.length - open.length;
  const shown = all ? rows : open;
  return (
    <div className="flex h-full flex-col gap-2 overflow-y-auto p-3" data-testid="asks-panel" data-quote-from="your asks">
      {/* (The panel's head names it.) */}
      {settled > 0 && (
        <div className="flex justify-end px-1">
          <button type="button" className="k-myask-link" onClick={() => setAll(!all)} data-testid="asks-all" title={`${settled} running or reported`}>
            {all ? "Only open ones" : "With the settled ones"}
          </button>
        </div>
      )}
      {rows.length === 0 ? (
        <p className="k-empty px-1"><b>Nothing asked yet</b>What you ask for here shows with its state: working, in review, on main, running. It is read from the agents, branches and landings, not from what a model says.</p>
      ) : shown.length === 0 ? (
        <p className="k-empty px-1" data-testid="asks-none-open"><b>Nothing open</b>Every ask here runs, or its agents reported.</p>
      ) : (
        <ul className="flex flex-col" data-testid="asks-list">
          {shown.map((r) => <Row key={r.a.id} a={r.a} state={r.state} agents={r.agents} unknown={r.unknown} />)}
        </ul>
      )}
    </div>
  );
}

export default AsksPanel;
