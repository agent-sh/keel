// Under the step of a parent that started agents, while any agent of its tree
// works: one line per agent of the whole tree (its own agents, theirs, and so
// on), each with its name, its place in the tree, its state in the one word
// every surface uses, what it is doing now, how long it has worked, and a press
// that opens it (where it waits on the owner, at what it asks). As Claude
// Code's background agents are one status line each under their Agent card,
// and a press opens the agent's own transcript, as Codex opens a subagent's.
//
// What it costs the page: the agent records and their sessions' states are in
// every page already; the lines of what each agent does now come to this view
// for its own agents, and through the tree's feed for the ones further down,
// read only while a line shows an agent at work below the first level.
import { ExternalLink } from "lucide-react";
import type React from "react";
import { useEffect, useMemo } from "react";
import { isLive, openSession, useAuto, type AgentRecord } from "../../lib/automation.ts";
import { treeLines, treeRoot, type AgentLine } from "../../lib/agent-lines.ts";
import { scope, useStore } from "../../lib/store.ts";
import { useToldStates } from "../../lib/watch.ts";
import { briefText, whyText } from "../../../../src/core/watch.ts";
import { STATE_WORD, agentWhy } from "../../../../src/core/state-words.ts";
import { beatOf } from "../../lib/clock.ts";
import { elapsed, useNow } from "../Mark.tsx";
import { openWaiting } from "../HomeWatch.tsx";
import { AgentMark, nowMeta } from "./bits.tsx";

// `from`: the agents the step started, in its order. `sid`: the session whose view shows the step.
// `below`: only the agents below them (a step of one agent has its card, with its own line, above these).
export function AgentLines({ from, sid, below }: { from: AgentRecord[]; sid: string; below?: boolean }) {
  const all = useAuto((s) => s.agents);
  const nowLines = useAuto((s) => s.now);
  const told = useToldStates();
  const sessions = useStore((s) => s.sessions);
  const list = useMemo(() => Object.values(all), [all]);
  const tree = useMemo(() => treeLines(list, from, told), [list, from, told]);
  const lines = useMemo(() => (below ? tree.filter((l) => l.depth > 1).map((l) => ({ ...l, depth: l.depth - 1 })) : tree), [tree, below]);
  const live = lines.some((l) => isLive(l.agent));
  // The lines of the agents below the first level come by the tree's feed; this view hears its own agents' lines.
  const deep = tree.some((l) => l.depth > 1 && isLive(l.agent));
  const root = useMemo(() => treeRoot(list, sid), [list, sid]);
  useEffect(() => (live && deep ? scope.feed(`tree:${root}`) /* the tree feed of src/server/scope.ts (treeFeed) */ : undefined), [live, deep, root]);
  const first = Math.min(...lines.filter((l) => isLive(l.agent)).map((l) => nowLines[l.agent.id]?.since ?? l.agent.task_at ?? l.agent.created));
  const now = useNow(live, beatOf(Number.isFinite(first) ? first : undefined));
  if (!live) return null;
  return (
    <ul className="k-agent-lines" data-testid="agent-lines" aria-label={`${lines.length} agent${lines.length === 1 ? "" : "s"} of this step and below`}>
      {lines.map((l) => <Line key={l.agent.id} l={l} title={sessions[l.agent.session_id]?.title || l.agent.title} now={now} />)}
    </ul>
  );
}

function Line({ l, title, now }: { l: AgentLine<AgentRecord>; title: string; now: number }) {
  const a = l.agent;
  const st = l.state;
  const line = useAuto((s) => s.now[a.id]);
  const on = isLive(a);
  const need = st.watch === "need";
  // What it is doing now: what it asks the owner, else its now line, else the reason of its state; an ended one, why it ended.
  const step = need ? (st.text ? whyText(st, now) : "") : on ? line?.text || (st.text ? briefText(st, now) : "") : agentWhy(a) ?? "";
  const start = (on ? line?.since : undefined) ?? a.task_at ?? a.created;
  const time = on ? elapsed(now - start) : a.ended ? elapsed(a.ended - start) : "";
  const meta = on && line ? nowMeta(line, now) : time;
  const open = () => (need ? openWaiting(a.session_id) : openSession(a.session_id));
  return (
    <li className="k-agent-line-row" data-depth={l.depth} style={l.depth > 1 ? ({ "--k-indent": `${(l.depth - 1) * 1.125}rem` } as React.CSSProperties) : undefined}>
      <button
        type="button" className="k-agent-line" data-testid="agent-line" data-agent={a.id} data-depth={l.depth} data-watch={st.watch} data-need={need || undefined}
        aria-label={`${title}, ${l.depth > 1 ? `${l.depth - 1} level${l.depth > 2 ? "s" : ""} down, ` : ""}${STATE_WORD[st.watch]}${step ? `: ${step}` : ""}${time ? `, ${time}` : ""}. Open it`}
        title={`${title}\n${STATE_WORD[st.watch]}${step ? `: ${step}` : ""}${meta ? `\n${meta}` : ""}`}
        onClick={open}
      >
        <AgentMark w={st.watch} />
        <span className="k-agent-line-name" data-testid="agent-line-name">{title}</span>
        <span className="k-agent-line-word" data-watch={st.watch} data-testid={need ? "agent-line-need" : "agent-line-state"}>{STATE_WORD[st.watch]}</span>
        {step && <span className="k-agent-line-step" data-testid="agent-line-step">{step}</span>}
        <span className="k-agent-line-end">
          {time && <span className="k-agent-line-time" data-testid="agent-line-time">{time}</span>}
          <ExternalLink className="k-agent-line-open" aria-hidden="true" />
        </span>
      </button>
    </li>
  );
}
