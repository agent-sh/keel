import { Bell, BellOff, ChevronRight, Gauge, ListCollapse, Moon, Repeat } from "lucide-react";
import type React from "react";
import { useCap } from "../../lib/caps.ts";
import { capTip, dollars } from "../../../../src/automation/cap-rules.ts";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { endedUnseen, useAgentsSeen } from "../../lib/agent-seen.ts";
import { isLive, openSession, snoozeText, useAuto } from "../../lib/automation.ts";
import { COUNTERS, NEW, agentTally, countName, wentWrongWord } from "../../../../src/core/state-words.ts";
import { actions, reportError, useStore } from "../../lib/store.ts";
import { cn } from "../../lib/utils.ts";
import { AgentMark, AgentNow, agentSaid, IconButton, StopAgent } from "./bits.tsx";
import { AgentLane } from "./Lane.tsx";
import { scope } from "../../lib/store.ts";
import { Mark } from "../Mark.tsx";
import { useNeedCount, useToldStates } from "../../lib/watch.ts";
import { Where } from "../Where.tsx";
import { calls, useSettled } from "../../lib/settle.ts";
import type { Watch } from "../../../../src/core/watch.ts";
import { treeRows } from "../../../../src/core/agent-tree.ts";
import { isCounted } from "../../../../src/core/agent-count.ts";

// The panels load the first time they open.
const InboxPanel = lazy(() => import("./InboxPanel.tsx").then((m) => ({ default: m.InboxPanel })));
const LoopsPanel = lazy(() => import("./LoopsPanel.tsx").then((m) => ({ default: m.LoopsPanel })));

// Under a session row: the agents it started and theirs, as a tree (each
// agent's own under it, indented a step a level), each with its state in the one
// word every other surface uses for it (src/core/state-words.ts), and stop. Children
// never appear in the top-level list and never count as unread on their own.
// The summary is one line that never wraps: how many agents, then every state
// with agents in it as its mark and its count, what needs the owner or failed
// first and in words. Every agent is in exactly one count, so they add up to
// the total; the whole sentence is the line's name and tooltip. The list is
// folded to that line until the owner opens it; their choice is kept per session.
const OPEN_KEY = "keel.agentsOpen";
const openKept = (): Record<string, boolean> => { try { return JSON.parse(localStorage.getItem(OPEN_KEY) ?? "{}"); } catch { return {}; } };

export function SessionChildren({ parentId, current }: { parentId: string; current: string | null }) {
  const onPick = openSession;
  const all = useAuto((s) => s.agents);
  const sessions = useStore((s) => s.sessions);
  // Which agent the parent's unread alerts came from (looking is not reading).
  const unread = useAuto((s) => s.unread.children ?? {});
  // The agents every count of the row names (src/core/agent-count.ts): a page open for days does not keep counting old ones.
  // (The tree is made of every agent the page holds, so a live one under an old one is reached; the old one is not shown.)
  const rows = useMemo(() => treeRows(Object.values(all), parentId).filter((r) => isCounted(r.agent)), [all, parentId]);
  const liveKids = useMemo(() => rows.map((r) => r.agent), [rows]);
  const place = useMemo(() => new Map(rows.map((r) => [r.agent.id, { depth: r.depth, below: r.below }])), [rows]);
  const told = useToldStates();
  const seen = useAgentsSeen();
  const liveSaid = useMemo(() => liveKids.map((k) => agentSaid(k, told[k.session_id])), [liveKids, told]);
  // As the list shows them (lib/settle.ts): twelve agents started in a breath are one change of the
  // line, made with the parent's row; an agent that comes to need the owner, fails or is declined, or
  // leaves one of those, is shown at once.
  const calling = (v: { kids: { id: string }[]; said: { watch: Watch }[] }) => v.said.map((x, i) => (calls(x.watch) ? `${v.kids[i]!.id}:${x.watch}` : "")).filter(Boolean).join(" ");
  const live = useMemo(() => ({ kids: liveKids, said: liveSaid }), [liveKids, liveSaid]);
  const { kids, said } = useSettled(`kids:${parentId}`, live, liveKids.map((k, i) => `${k.id}:${liveSaid[i]!.watch}:${liveSaid[i]!.title}`).join(" "), (was) => calling(live) !== calling(was));
  const sum = useMemo(() => agentTally(said.map((x) => x.watch)), [said]);
  const viewing = kids.find((k) => k.session_id === current);
  const [expanded, setExpanded] = useState(() => openKept()[parentId] === true);
  // The rows whose lane is open: its five lines under it (./Lane.tsx).
  const [lanes, setLanes] = useState<ReadonlySet<string>>(() => new Set());
  const foldLane = (id: string) => setLanes((was) => { const n = new Set(was); if (!n.delete(id)) n.add(id); return n; });
  // The list leaves out the sessions of agents at rest: their rows (a title the owner gave one) are read once the agents are opened.
  const left = useStore((s) => s.agentsLeft[parentId] ?? 0);
  useEffect(() => { if (expanded && left) actions.loadAgentsOf(parentId).catch(reportError); }, [expanded, left, parentId]);
  // While the tree's rows show and an agent of it works, what each is doing comes to this page (lib/scope.ts).
  const working = liveKids.some(isLive);
  useEffect(() => (expanded && working ? scope.feed(`tree:${parentId}`) /* the tree feed of src/server/scope.ts (treeFeed) */ : undefined), [expanded, working, parentId]);
  const setOpen = (o: boolean) => {
    setExpanded(o);
    const m = openKept();
    if (o) m[parentId] = true; else delete m[parentId];
    localStorage.setItem(OPEN_KEY, JSON.stringify(m));
  };
  if (!kids.length) return null;
  // Folded, an agent that ended since the owner looked is said on the line.
  const fresh = kids.filter((k) => endedUnseen(k, seen)).length;
  return (
    <div className="k-session-children" data-testid="session-children">
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={sum.text}
        title={sum.text}
        data-testid="children-toggle"
        onClick={() => setOpen(!expanded)}
        className="k-kids-sum"
        data-many={sum.parts.length > 5 || undefined}
        // Two states or fewer are said in words ("4 agents · 3 working · 1 done"); more are each a mark and a figure, the words in the tooltip.
        data-words={sum.parts.length <= 2 || undefined}
      >
        {/* The counts, never cut: on a list too narrow for one line of them they take a second. */}
        <span className="k-kids-counts">
        <ChevronRight className={cn("k-kids-fold", expanded && "rotate-90")} />
        <span className="k-kids-total" data-testid="children-total"><b className="k-kids-n">{kids.length}</b><span className="k-kids-label"> agent{kids.length > 1 ? "s" : ""}</span></span>
        <span className="k-kids-parts" data-testid="children-summary">
          {sum.parts.map((p) => (
            <span key={p.w} className="k-kids-part" data-watch={p.w} data-testid={p.w === "need" ? "children-asking" : `children-${p.w}`} data-count={p.n} title={p.text}>
              <Mark w={p.w} /><b className="k-kids-n">{p.n}</b><span className="k-kids-word"> {countName(p.w, p.n)}</span>
            </span>
          ))}
        </span>
        </span>
        {/* Not counts: they have the room the counts leave, and go whole where that is too little (the line's name has them). */}
        {!expanded && (fresh > 0 || viewing) && (
          <span className="k-kids-extra">
            {fresh > 0 && <span className="k-kids-new" data-testid="children-fresh" title="Ended since you looked">{fresh} {NEW.toLowerCase()}</span>}
            {viewing && <span className="k-kids-viewing" data-testid="children-viewing">viewing {sessions[viewing.session_id]?.title || viewing.title}</span>}
          </span>
        )}
      </button>
      {expanded && kids.map((a, i) => {
        // The settled list (its said rows) with each agent's place in the tree, read from the live tree by id.
        const { depth, below } = place.get(a.id) ?? { depth: 1, below: 0 };
        const st = said[i]!;
        const title = sessions[a.session_id]?.title || a.title;
        const news = endedUnseen(a, seen);
        return (
          // The row opens the agent; Stop is a control of its own over the row's end, never inside the open target.
          <div key={a.id} className="k-child-row" data-live={isLive(a) || undefined} data-lane={lanes.has(a.id) || undefined} data-testid="child-row" data-depth={depth} style={depth > 1 ? ({ "--k-indent": `${(depth - 1) * 0.875}rem` } as React.CSSProperties) : undefined}>
            <div
              role="button"
              tabIndex={0}
              data-testid="child-session"
              data-watch={st.watch}
              data-asking={st.watch === "need" || undefined}
              data-fresh={news || undefined}
              data-current={current === a.session_id || undefined}
              aria-label={`${title}, ${st.title}${below ? `, ${below} agent${below > 1 ? "s" : ""} below it` : ""}${news ? ", ended since you looked" : ""}`}
              // The row may be too narrow for the title or the word: the tooltip carries both.
              title={`${title}: ${st.title}`}
              onClick={() => onPick(a.session_id)}
              onKeyDown={(e) => {
                if (e.key !== "Enter" && e.key !== " ") return;
                e.preventDefault();
                onPick(a.session_id);
              }}
              className="k-child-session"
            >
              <AgentMark w={st.watch} />
              <span className="k-child-title" data-quiet={(!isLive(a) && !unread[a.session_id] && !news) || undefined} data-new={!!(unread[a.session_id] || news) || undefined} data-testid="child-title">{title}</span>
              {/* How many agents are below it: the rows that follow, a step further in. */}
              {below > 0 && <span className="k-child-below" data-testid="child-below" title={`${below} agent${below > 1 ? "s" : ""} below it`}>+{below}</span>}
              <span className="k-child-state" data-watch={st.watch} data-testid="child-state">{st.word}</span>
              <ChildCap id={a.session_id} title={title} />
              {/* Its parent's section says where it runs; only an agent placed elsewhere names its machine. */}
              {(sessions[a.session_id]?.machine ?? a.machine ?? undefined) !== (sessions[parentId]?.machine ?? undefined) && <Where s={{ machine: sessions[a.session_id]?.machine ?? a.machine }} />}
              {unread[a.session_id] || news ? (
                <span data-testid={unread[a.session_id] ? "child-unread" : "child-fresh"} title={unread[a.session_id] ? `${unread[a.session_id]} unread` : "Ended since you looked"} className="k-child-dot">
                  <span aria-hidden />
                  <span className="sr-only">{unread[a.session_id] ? `${unread[a.session_id]} unread` : "ended since you looked"}</span>
                </span>
              ) : null}
            </div>
            <span className="k-child-acts">
              <IconButton title={`${lanes.has(a.id) ? "Hide" : "Show"} what ${title} is doing, waits for, got wrong, changed and does next`} onClick={() => foldLane(a.id)} testid="child-lane-fold">
                <ListCollapse className={cn("size-3.5", lanes.has(a.id) && "text-fg")} aria-hidden />
              </IconButton>
              {isLive(a) && <StopAgent a={a} title={title} testid="child-stop" />}
            </span>
            <AgentNow a={a} className="k-child-now" />
            {lanes.has(a.id) && <AgentLane a={a} className="k-child-lane" testid="child-lane" />}
          </div>
        );
      })}
    </div>
  );
}

// An agent with a dollar budget: the share spent and the rate, as a session's row says them.
function ChildCap({ id, title }: { id: string; title: string }) {
  const cap = useCap(id);
  if (!cap) return null;
  return <span className="k-row-cap" data-testid="child-cap" data-level={cap.level} title={capTip(cap, title)}><Gauge aria-hidden="true" />{Math.floor(cap.pct * 100)}%{cap.burn_hour > 0 && <span className="k-row-cap-rate">{dollars(cap.burn_hour)}/h</span>}</span>;
}

// On a session row: unread alerts and scheduled work.
export function SessionBadges({ sessionId }: { sessionId: string }) {
  const unread = useAuto((s) => s.unread.sessions[sessionId] ?? 0);
  const loops = useAuto((s) => Object.values(s.loops).some((l) => l.session_id === sessionId && l.enabled));
  const snoozed = useAuto((s) => s.snoozes[sessionId]);
  return (
    <>
      {snoozed && !snoozed.suspended && <Moon data-testid="snoozed-mark" className="k-snoozed-mark size-3 shrink-0 text-faint" aria-label={`Snoozed ${snoozeText(snoozed)}`} />}
      {/* A wait is the row's own state (Waiting, with what it waits for); a loop is scheduled work beside it. */}
      {loops && <Repeat className="size-3 shrink-0 text-faint" aria-label="Scheduled work" />}
      {unread > 0 && <span data-testid="unread-dot" title={`${unread} unread`} className="k-unread-dot size-2 shrink-0 rounded-full bg-accent" />}
    </>
  );
}

// Inbox and Loops buttons with their panels.
export function AutomationFooter() {
  const [inbox, setInbox] = useState(() => new URLSearchParams(location.search).has("inbox"));
  const [loops, setLoops] = useState(false);
  // The desktop shell opens the inbox on a click that names no session (ui/src/features/shell.ts).
  useEffect(() => {
    const open = () => setInbox(true);
    addEventListener("keel-open-inbox", open);
    return () => removeEventListener("keel-open-inbox", open);
  }, []);
  const [seen, setSeen] = useState({ inbox: false, loops: false });
  if ((inbox && !seen.inbox) || (loops && !seen.loops)) setSeen({ inbox: seen.inbox || inbox, loops: seen.loops || loops });
  // The "Open the inbox" command (a key, the palette): the same press closes it again.
  useEffect(() => {
    const toggle = () => setInbox((o) => !o);
    addEventListener("keel:inbox", toggle);
    return () => removeEventListener("keel:inbox", toggle);
  }, []);
  return (
    <>
      <FooterButtons onInbox={() => setInbox(true)} onLoops={() => setLoops(true)} />
      <Suspense fallback={null}>
        {seen.inbox && <InboxPanel open={inbox} onOpenChange={setInbox} />}
        {seen.loops && <LoopsPanel open={loops} onOpenChange={setLoops} />}
      </Suspense>
    </>
  );
}

function FooterButtons({ onInbox, onLoops }: { onInbox: () => void; onLoops: () => void }) {
  const liveUnread = useAuto((s) => s.unread.total);
  const loops = useAuto((s) => Object.values(s.loops).filter((l) => l.enabled).length);
  const held = useAuto((s) => !!s.snoozes["*"]);
  // What waits on the owner is the one count of the tab's title and the home headline (useNeedCount).
  // Other news is unread that is not that: a session that needs the owner has its ask unread, which the count has.
  const need = useNeedCount();
  const told = useToldStates();
  const unreadBy = useAuto((s) => s.unread.sessions);
  // Unread that is not a session needing the owner is the dot; the ones among it that failed or were declined
  // colour it, so a failure is still in front of the owner without a number.
  const liveOthers = useMemo(() => {
    const ofSessions = Object.values(unreadBy).reduce((n, c) => n + (c ?? 0), 0);
    const rest = Object.entries(unreadBy).filter(([id, c]) => (c ?? 0) > 0 && told[id]?.watch !== "need");
    const failed = rest.filter(([id]) => told[id]?.watch === "fail").length;
    const declined = rest.filter(([id]) => told[id]?.watch === "declined").length;
    return { others: rest.length + Math.max(0, liveUnread - ofSessions), failed, declined };
  }, [unreadBy, told, liveUnread]);
  // Counted as the list counts (lib/settle.ts): finishes coming one after another move the dot once
  // they have settled; what waits on the owner, and what they read, move it at once.
  const { unread, others, failed, declined } = useSettled("bell", { unread: liveUnread, ...liveOthers }, `${liveUnread}|${liveOthers.others}|${liveOthers.failed}|${liveOthers.declined}`, (was) => need > 0 || liveUnread < was.unread || liveOthers.others < was.others || liveOthers.failed > was.failed || liveOthers.declined > was.declined);
  const wrong = failed + declined;
  const said = `Inbox. ${need ? `${COUNTERS.waiting(need)}. ` : ""}${COUNTERS.unread(unread)}${wrong ? `. ${wrong} ${wentWrongWord(failed, declined)}` : ""}${held ? ". Alerts are snoozed" : ""}`;
  return (
    <>
      <button
        type="button"
        data-testid="inbox-button"
        onClick={onInbox}
        // The bell counts what waits on the owner, in the color of that; other news is a muted dot.
        title={said}
        aria-label={said}
        className={cn("relative flex h-ctl-md items-center gap-1.5 rounded-md px-2 text-caption hover:bg-raised", need || others ? "text-fg" : "text-faint")}
      >
        <span className="relative grid place-items-center">
          {held ? <BellOff className="size-3.5" /> : <Bell className="size-3.5" />}
          {others > 0 && <span data-testid="bell-dot" data-watch={wrong ? "fail" : undefined} className="k-inbox-dot" />}
        </span>
        {need > 0 && <span data-testid="inbox-count" data-watch="need" className="k-inbox-count tabular-nums">{need}</span>}
      </button>
      <button
        type="button"
        data-testid="loops-button"
        onClick={onLoops}
        // Named by its word, with the count it shows: the count alone named the button "2".
        title={loops > 0 ? `Loops. ${loops} on` : "Loops"}
        aria-label={loops > 0 ? `Loops. ${loops} on` : "Loops"}
        className="flex items-center gap-1.5 h-ctl-md rounded-md px-2 text-caption text-faint hover:bg-raised hover:text-fg"
      >
        <Repeat className="size-3.5" />
        {loops > 0 && <span className="tabular-nums">{loops}</span>}
      </button>
    </>
  );
}
