import { Collapsible } from "@base-ui/react/collapsible";
import { AlertTriangle, Bot, ChevronRight, CornerDownRight, ExternalLink, Flag, GitBranch, Mail, Network, Radio, ScanSearch, Repeat, Timer, Zap } from "lucide-react";
import { useMemo } from "react";
import type { StoredEvent, ToolResultBlock, ToolUseBlock } from "../../../../src/core/types.ts";
import { auto, isLive, openSession, useAuto, type AgentRecord } from "../../lib/automation.ts";
import { machineName } from "../../lib/fleet.ts";
import { reportError, useStore } from "../../lib/store.ts";
import { resultText } from "../../lib/tools.ts";
import { callState, failureLine, type CallState } from "../../lib/work.ts";
import { Apart, Under } from "../ToolCall.tsx";
import { savePref } from "../../lib/ui.ts";
import { cn } from "../../lib/utils.ts";
import { useToldState } from "../../lib/watch.ts";
import { Markdown } from "../Markdown.tsx";
import { AgentStatus, agentWhy, IconButton, STATUS_LABEL, StopIcon } from "./bits.tsx";

export const AGENT_TOOLS = new Set(["Agent", "spawn_agent"]);
export { SYSTEM_INPUT } from "../../../../src/core/owner.ts";
import { SYSTEM_INPUT } from "../../../../src/core/owner.ts";

type Report = { id: string; title: string; status: AgentRecord["status"]; text: string; why?: string; key: string; task?: string };

// The daemon escapes only a frame's own tag inside it (core.ts inert): only
// that is undone here, so a report's own "&lt;" stays as it was written.
const unframe = (text: string, tag: string) => text.replace(new RegExp(`&lt;(\\s*/?\\s*${tag})`, "gi"), "<$1");
const attrOf = (attrs: string, name: string) => attrs.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];

// `meta`: the input's meta; each report takes its report_id from the parts in
// order (an input can carry two reports of one agent, one per task). Older
// inputs have none: agent and position stand in.
function reports(text: string, meta?: Record<string, any>): Report[] {
  const out: Report[] = [];
  const parts = ((meta?.parts ?? [meta ?? {}]) as Record<string, any>[]).filter((p) => p.kind === "subagent");
  const used = new Set<number>();
  const re = /<subagent_result agent_id="([^"]*)" title="([^"]*)" status="([^"]*)"([^>]*)>\n?([\s\S]*?)\n?<\/subagent_result>/g;
  for (const m of text.matchAll(re)) {
    const status = m[3] as Report["status"];
    const at = parts.findIndex((p, i) => !used.has(i) && p.agent_id === m[1]);
    if (at >= 0) used.add(at);
    const key = (at >= 0 && parts[at]!.report_id) || `${m[1]}#${out.length}`;
    out.push({ id: m[1]!, key, title: m[2]!, status, text: unframe(m[5]!, "subagent_result"), why: agentWhy({ status, stopped_by: attrOf(m[4]!, "stopped_by"), end_reason: attrOf(m[4]!, "ended") }) });
  }
  // One agent with more than one report here: each says which task it answers.
  for (const r of out) {
    const same = out.filter((o) => o.id === r.id);
    if (same.length > 1) r.task = same.at(-1) === r ? "latest task" : "earlier task";
  }
  return out;
}

// The failure notice inside an input (src/automation/failures.ts): its entries,
// the lines after them, and the input's text without it.
const FAILURES = /\[harness\] Failures in this session's work[^\n]*\n<failures>\n([\s\S]*?)\n<\/failures>((?:\n(?!\n)[^\n]*)*)/g;
function failuresOf(text: string, meta: Record<string, any>) {
  const part = ((meta.parts ?? [meta]) as Record<string, any>[]).find((p) => p.kind === "failures");
  if (!part) return undefined;
  // The last one: the notice goes after what it comes with, so a report that quotes one is not taken for it.
  const m = [...text.matchAll(FAILURES)].at(-1);
  if (!m) return undefined;
  // What the entries name: a failure left to a report in the same input is not counted here.
  const groups = ((part.groups ?? []) as { owed: number; said?: number }[]).map((g) => g.said ?? g.owed ?? 0).filter((n) => n > 0);
  const n = groups.reduce((s, g) => s + g, 0);
  return {
    body: unframe(m[1]!, "failures"),
    after: m[2]!.trim(),
    rest: (text.slice(0, m.index) + text.slice(m.index! + m[0].length)).trim(),
    sub: `${n} failure${n === 1 ? "" : "s"}, ${groups.length} cause${groups.length === 1 ? "" : "s"}`,
  };
}

// An input's parts that have cards of their own, and its text without them:
// what a loop run, a goal's input or another message said in the same input.
const hasCard = (p: Record<string, any>) => p.kind === "subagent" || p.kind === "wait" || p.kind === "failures" || (p.kind === "harness" && p.status === "waiting");
const CARDED = /(?:Reports from agents you started follow\.[^\n]*\n)?<subagent_result [^>]*>[\s\S]*?<\/subagent_result>(?:\n(?!\n)[^\n]*)*|<wait_fired [^>]*>[\s\S]*?<\/wait_fired>|<monitor_event [^>]*>[\s\S]*?<\/monitor_event>|^\[harness\] Agent \S+ parked on [^\n]*$/gm;
const withoutCards = (text: string) => text.replace(CARDED, "").replace(/\n{3,}/g, "\n\n").trim();

// Each wake with its own header: a monitor's note (or short id) beside its batch number.
function wakes(text: string) {
  const out: { label: string; body: string }[] = [];
  const re = /<wait_fired id="[^"]*" kind="([^"]*)" outcome="([^"]*)">\n?([\s\S]*?)\n?<\/wait_fired>|<monitor_event id="([^"]*)" batch="(\d+)"([^>]*)>\n?([\s\S]*?)<\/monitor_event>/g;
  for (const m of text.matchAll(re)) {
    if (m[5]) out.push({ label: `${attrOf(m[6]!, "note") || `monitor ${m[4]!.slice(-6)}`} · batch ${m[5]}`, body: unframe(m[7]!, "monitor_event").trimEnd() });
    else out.push({ label: m[2] === "fired" ? `${m[1]} fired` : m[2] === "timeout" ? `${m[1]} timed out` : `${m[1]} ${m[2]}`, body: unframe(m[3]!, "wait_fired") });
  }
  return out;
}

// What a wait waits for, then where: the condition comes first so two waits
// on the same target read differently.
export function waitWhat(k: any): string {
  switch (k.kind) {
    case "timer": return k.seconds !== undefined ? `timer ${k.seconds}s` : "timer";
    case "file": return k.contains !== undefined ? `contains "${k.contains}" · ${k.path}` : `exists · ${k.path}`;
    case "log": return `line /${k.match}/ · ${k.path}`;
    case "http": return `HTTP ${k.status ?? "2xx/3xx"} · ${k.url}`;
    case "process": return `process ${k.pid} ends`;
    case "pr_checks": return `checks done · ${k.repo}#${k.pr_number}`;
    default: return `${k.kind ?? "wait"} ${k.path ?? k.url ?? k.pid ?? ""}`.trim();
  }
}

// One line for the automation tools' cards.
export function toolSummary(name: string, input: any): string | undefined {
  switch (name) {
    case "WaitFor": case "wait_for":
      return `${waitWhat(input)}${input.note ? ` · ${input.note}` : ""}`;
    case "Monitor": case "monitor":
      return `${input.description ? `${input.description} · ` : ""}${input.command ?? ""}`;
    case "ScheduleWakeup": case "schedule_wakeup":
      return input.stop ? "stop the loop" : `next run in ${input.delaySeconds ?? input.delay_seconds ?? "?"}s${input.reason ? ` · ${input.reason}` : ""}`;
    case "CronCreate": case "schedule_create":
      return `${input.cron ?? input.schedule} · ${input.prompt ?? ""}`;
    case "CronDelete": case "schedule_delete": case "TaskStop": case "cancel_wait": case "close_agent":
      return input.id ?? input.task_id ?? input.wait_id ?? input.target;
    case "SendMessage": case "send_input":
      return `${input.to ?? input.target} · ${input.summary ?? input.message ?? ""}`;
    case "PushNotification": case "notify":
      return input.message ?? input.text;
    case "CronList": case "schedule_list":
      return "scheduled tasks, waits and agents";
    case "advisor":
      return input.question ? `asks: ${input.question}` : "a check of where things stand";
    default:
      return undefined;
  }
}

function Shell({ icon: Icon, label, sub, children, testid, defaultOpen, tone }: { icon: typeof Bot; label: string; sub?: string; children?: React.ReactNode; testid: string; defaultOpen?: boolean; tone?: "danger" }) {
  return (
    <Collapsible.Root defaultOpen={defaultOpen} className="group/in animate-in rounded-lg border border-dashed border-line-strong bg-sunken/60" data-testid={testid}>
      <Collapsible.Trigger className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-caption text-muted outline-none hover:text-fg">
        <Icon className={cn("size-3.5 shrink-0", tone === "danger" ? "text-danger" : "text-accent")} />
        <span className="font-medium text-fg">{label}</span>
        {sub && <span className="min-w-0 truncate text-faint">{sub}</span>}
        <ChevronRight className="ml-auto size-3.5 shrink-0 text-faint transition-transform group-data-[open]/in:rotate-90" />
      </Collapsible.Trigger>
      <Collapsible.Panel className="overflow-hidden">{children}</Collapsible.Panel>
    </Collapsible.Root>
  );
}

// A message the harness put in the conversation: an agent's report, a wake, a
// loop run, a task. Shown as what it is, never as the owner's words.
export function InputNotice({ e }: { e: StoredEvent }) {
  const kind = e.data.kind as string;
  const text = String(e.data.text ?? "");
  const sessions = useStore((s) => s.sessions);
  const rs = useMemo(() => reports(text, e.data), [text, e.data]);
  const ws = useMemo(() => wakes(text), [text]);
  const fails = useMemo(() => failuresOf(text, e.data), [text, e.data]);

  // One input can carry agents' reports and wakes together: every part shows.
  const reportCards = rs.length > 0 && (kind === "subagent" || kind === "wake") && (
    <div className="flex flex-col gap-2 animate-in" data-testid="agent-reports">
      {rs.map((r) => (
        <Collapsible.Root key={r.key} className="group/rep rounded-lg border border-line bg-raised shadow-1" data-testid="agent-report" data-status={r.status}>
          <Collapsible.Trigger className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-ui outline-none">
            <CornerDownRight className="size-3.5 shrink-0 text-faint" />
            <AgentStatus status={r.status} />
            <span className="font-medium">{r.title}</span>
            <span className="min-w-0 truncate text-caption text-faint" data-testid="agent-report-status">reported{r.task ? ` · ${r.task}` : ""} · {STATUS_LABEL[r.status] ?? r.status}{r.why ? ` · ${r.why}` : ""}</span>
            <ChevronRight className="ml-auto size-3.5 shrink-0 text-faint transition-transform group-data-[open]/rep:rotate-90" />
          </Collapsible.Trigger>
          <Collapsible.Panel className="overflow-hidden border-t border-line px-4 py-3 text-ui"><Markdown text={r.text} /></Collapsible.Panel>
        </Collapsible.Root>
      ))}
    </div>
  );
  const wakeCard = (kind === "wait" || (kind === "wake" && ws.length > 0)) && (
    <Shell icon={kind === "wait" && e.data.outcome === "event" ? Radio : Timer} label={`Woken: ${ws.map((w) => w.label).join(", ") || "a wait ended"}`} testid="wake-notice">
      <div className="mx-3 mb-3 flex max-h-60 flex-col gap-2 overflow-auto rounded-lg bg-code p-2.5 font-mono text-caption text-muted">
        {ws.length ? ws.map((w, i) => (
          <div key={i} data-testid="wake-part">
            <div className="text-faint">{w.label}</div>
            <pre className="whitespace-pre-wrap">{w.body}</pre>
          </div>
        )) : <pre className="whitespace-pre-wrap">{text}</pre>}
      </div>
    </Shell>
  );
  const parks = ((e.data.parts ?? [e.data]) as Record<string, any>[]).filter((p) => p.kind === "harness" && p.status === "waiting" && typeof p.waiting_on === "string");
  const parkCards = parks.map((p) => (
    <Shell key={p.agent_id} icon={Timer} label="Agent waiting" sub={p.agent_id} testid="agent-park-notice">
      <p className="mx-3 mb-3 whitespace-pre-wrap text-ui text-muted">Agent {p.agent_id} parked on {p.waiting_on}. It has not finished.</p>
    </Shell>
  ));
  // What failed around the session, one entry per cause: open, since it is what needs a look.
  const failCard = fails && (
    <Shell icon={AlertTriangle} tone="danger" label="Failures, grouped by cause" sub={fails.sub} testid="failure-notice" defaultOpen>
      <div className="mx-3 mb-3 flex max-h-80 flex-col gap-2 overflow-auto rounded-lg bg-code p-2.5 font-mono text-caption text-muted">
        {/* An entry's first line hangs; who failed, each with its own failure, sits under it, and stays there when a line wraps. */}
        <div data-testid="failure-entries">
          {fails.body.split("\n").map((line, i) => (
            <div key={i} className={cn("whitespace-pre-wrap break-words", line.startsWith("- ") ? "pl-4 -indent-4 text-fg" : "pl-8 text-muted", i > 0 && line.startsWith("- ") && "mt-1.5")}>{line.trimStart()}</div>
          ))}
        </div>
        {fails.after && <p className="whitespace-pre-wrap font-sans text-faint">{fails.after}</p>}
      </div>
    </Shell>
  );
  if (reportCards || wakeCard || parkCards.length || (failCard && !fails.rest)) {
    // A part with no card of its own in the same input (a loop run, a goal's
    // input, a steer that brought reports along): as it reads, first, since it
    // is what started the turn.
    const others = ((e.data.parts ?? []) as Record<string, any>[]).filter((p) => !hasCard(p));
    const rest = others.length ? withoutCards(fails ? fails.rest : text) : "";
    const own = rest ? <InputNotice e={{ ...e, data: others.length === 1 ? { ...others[0], text: rest } : { ...e.data, text: rest, parts: others } }} /> : null;
    return <div className="flex flex-col gap-2">{own}{reportCards}{wakeCard}{parkCards}{failCard}</div>;
  }
  // With another input that has no card of its own: that one as it reads, then the failures.
  if (failCard) {
    const others = ((e.data.parts ?? []) as Record<string, any>[]).filter((p) => p.kind !== "failures");
    const data = others.length === 1 ? { ...others[0], text: fails.rest } : { ...e.data, text: fails.rest, parts: others };
    return <div className="flex flex-col gap-2"><InputNotice e={{ ...e, data }} />{failCard}</div>;
  }
  if (kind === "loop") {
    return (
      <Shell icon={Repeat} label="Loop run" sub={e.data.loop_name} testid="loop-notice">
        <p className="mx-3 mb-3 whitespace-pre-wrap text-ui text-muted">{text}</p>
      </Shell>
    );
  }
  if (kind === "goal") {
    const label = e.data.goal === "start" ? "Goal set" : e.data.goal === "resume" ? "Goal resumed" : "Goal not met yet: next turn";
    return (
      <Shell icon={Flag} label={label} testid="goal-notice" defaultOpen={e.data.goal === "start"}>
        <p className="mx-3 mb-3 whitespace-pre-wrap text-ui text-muted">{text.replace(/^\[harness\]\s*/, "")}</p>
      </Shell>
    );
  }
  if (kind === "task") {
    const parentId = sessions[e.session_id]?.parent_id;
    // The parent's words start at task_at; an older record without it shows the whole text.
    const at = e.data.task_at;
    const task = typeof at === "number" && at >= 0 && at <= text.length ? text.slice(at) : text;
    return (
      <div className="animate-in rounded-lg border border-line bg-raised shadow-1 px-4 py-3" data-testid="task-notice">
        <div className="flex items-center gap-2 text-caption text-muted">
          <Bot className="size-3.5 text-accent" /> Task from
          {parentId ? (
            <button type="button" onClick={() => openSession(parentId)} className="flex min-h-ctl-sm items-center gap-1 font-medium text-fg hover:text-accent">
              {sessions[parentId]?.title || "the parent session"} <ExternalLink className="size-3" />
            </button>
          ) : <span className="font-medium text-fg">the parent session</span>}
        </div>
        <p className="mt-1.5 whitespace-pre-wrap leading-relaxed">{task}</p>
      </div>
    );
  }
  return (
    <Shell icon={Zap} label={kind === "steer" ? "Message from the parent session" : "Harness note"} testid="harness-notice" defaultOpen={kind === "steer"}>
      <p className="mx-3 mb-3 whitespace-pre-wrap text-ui text-muted">{text}</p>
    </Shell>
  );
}


// The card of an Agent / spawn_agent call: the child's live state, open, stop.
const ENDED_WORD: Partial<Record<CallState, string>> = { error: "failed", denied: "denied by you", refused: "refused", stopped: "stopped", cut: "cut by a restart" };

export function AgentCall({ use, result, live }: { use: ToolUseBlock; result?: ToolResultBlock; live?: boolean }) {
  const input: any = use.input ?? {};
  const out = resultText(result);
  const agents = useAuto((s) => s.agents);
  const title = String(input.description ?? input.message ?? input.prompt ?? "").split("\n")[0]!.slice(0, 80);
  // The child this call started: the one its result names, or the one recorded
  // with this call's id. Never a guess by title: two agents can share one.
  const agent = useMemo(() => {
    const id = out.match(/agent[_ ](?:id=")?([0-9a-f]{12})|"agent_id":"([0-9a-f]{12})"/);
    if (id) return agents[id[1] ?? id[2]!];
    return Object.values(agents).find((a) => a.call_id === use.id);
  }, [agents, out, use.id]);
  const type = input.subagent_type ?? input.agent_type ?? "general-purpose";
  const report = agent && !isLive(agent) ? agent.result : undefined;
  const state = useToldState(agent?.session_id);
  const asking = agent && isLive(agent) && state?.watch === "need" ? state : undefined;
  // An agent that failed says so beside its name, with the reason under its line.
  const failedAgent = !!agent && !isLive(agent) && agent.status !== "completed" && agent.status !== "stopped";
  const why = agent ? agentWhy(agent) : undefined;
  const name = agent?.title ?? title;
  // With no agent the page knows of: how the call itself ended.
  const ended = !agent && result?.is_error ? callState(result) : undefined;

  return (
    <Collapsible.Root className="k-tool-call group/agent" data-testid="agent-call" data-state={failedAgent || (!agent && ended === "error") ? "error" : undefined}>
      {/* A line of the rail, as every call is: what it is, how it stands, its task; it opens to the task and the
          report. What can be done with the agent stands at the line's end, quiet until the line is pointed at. */}
      <div className="k-line-agent">
        <Collapsible.Trigger className="k-line">
          {/* (The words carry the title's name: what is cut, when the line is too narrow, is these words.) */}
          <span className="k-line-text" data-testid="agent-call-title">
            <span className="k-line-verb">Agent</span>{" "}
            {/* How it stands, beside the verb as on every line: it asks the owner, it runs, it failed, it was stopped.
                A finished agent needs no word on the page (it is said to a screen reader). */}
            {agent && (asking
              ? <span className="k-line-state" data-tone="need" data-testid="agent-call-status" data-asking title={asking.text}>Asks you</span>
              : (
                <span className={agent.status === "completed" ? "sr-only" : "k-line-state"} data-tone={failedAgent ? "fail" : "idle"} data-testid="agent-call-status" title={why}>
                  {STATUS_LABEL[agent.status]}{agent.background && isLive(agent) ? " in background" : ""}{why ? <span className="sr-only"> · {why}</span> : null}
                </span>
              ))}
            {/* A call that started no agent the page knows of says how it ended, by its result's own words. */}
            {!agent && ended && <span className="k-line-state" data-tone={ended === "error" ? "fail" : ended === "denied" ? "own" : ended === "stopped" ? "idle" : "warn"} data-testid="agent-call-ended">{ENDED_WORD[ended]}</span>}
            {" "}<span className="k-line-what" data-words="">{name}</span>
          </span>
          {/* What its parent sent and it has not read yet, kept in its queue. On a
              narrow line its words go before the agent's title is cut: it shrinks
              to the icon and the count, and its tooltip says the rest. */}
          {!!agent?.messages_waiting && (
            <span
              className="k-chip k-chip-gives"
              data-testid="agent-call-waiting"
              title={`${agent.messages_waiting === 1 ? "1 message" : `${agent.messages_waiting} messages`} sent to this agent and kept in its queue: it reads ${agent.messages_waiting === 1 ? "it" : "them"} at its next step, or when it goes on`}
            >
              <Mail className="size-3 shrink-0" /><span className="shrink-0">{agent.messages_waiting}</span><span className="min-w-0 truncate">{agent.messages_waiting === 1 ? "message waiting" : "messages waiting"}</span>
            </span>
          )}
          <span className="k-line-end">
            <Apart />
            <span className="k-chip">{type}</span>
            {agent?.branch && <span className="k-chip" data-code="" data-testid="agent-call-branch" title={`Its own worktree: ${agent.worktree}`}><GitBranch className="size-3" />{agent.branch}</span>}
            {(agent?.machine || input.machine) && <span className="k-chip" data-testid="agent-call-machine" title="Its tools run on this machine"><Network className="size-3" />{machineName(agent?.machine) ?? String(input.machine)}</span>}
            {agent?.structured && <span className="k-chip" data-code="" data-testid="agent-call-structured">json</span>}
            {(agent ? isLive(agent) && !asking : live) && <span className="k-line-run" aria-hidden="true" />}
          </span>
        </Collapsible.Trigger>
        {agent && (
          <span className="k-line-acts">
            {isLive(agent) && <IconButton title={`Stop agent ${name}`} danger onClick={() => auto.stopAgent(agent).catch(reportError)} testid="agent-call-stop"><StopIcon /></IconButton>}
            {!isLive(agent) && agent.branch && !agent.machine && (
              <IconButton title={`Review the work of agent ${name}`} onClick={() => auto.reviewAgent(agent).then(() => savePref("panel", "review")).catch(reportError)} testid="agent-call-review"><ScanSearch className="size-3.5" /></IconButton>
            )}
            <IconButton title={`Open the session of agent ${name}`} onClick={() => openSession(agent.session_id)} testid="agent-call-open"><ExternalLink className="size-3.5" /></IconButton>
          </span>
        )}
      </div>
      {/* Why it ended as it did, under its line: a failure's reason in its ink, a stop's quietly. */}
      {agent && !isLive(agent) && why && <div className="k-under"><Under tone={failedAgent ? "fail" : "note"} testid="agent-call-why">{why}</Under></div>}
      {!agent && ended === "error" && <div className="k-under"><Under code tone="fail" testid="agent-call-why">{failureLine(result)}</Under></div>}
      <Collapsible.Panel className="k-tool-panel overflow-hidden">
        <div className="k-label px-3 pt-2.5">Task</div>
        <p className="px-3 pt-1 text-ui whitespace-pre-wrap text-muted">{input.prompt ?? input.message}</p>
        {(report || out) && (
          <>
            <div className="k-label px-3 pt-3">Report</div>
            <div className="px-3 pt-1 pb-3 text-ui">
              {agent?.structured && report && agent.status === "completed"
                ? <pre data-testid="agent-call-json" className="overflow-x-auto rounded-md bg-code px-3 py-2 font-mono text-caption">{report.split("\n\n")[0]}</pre>
                : <Markdown text={report ?? out} />}
              {agent?.structured && report && agent.status === "completed" && report.includes("\n\n") && <p className="pt-2 text-caption text-muted">{report.slice(report.indexOf("\n\n") + 2)}</p>}
            </div>
          </>
        )}
        {!report && !out && <div className="h-2.5" />}
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}
