import { Collapsible } from "@base-ui/react/collapsible";
import { Bot, ChevronRight, CornerDownRight, ExternalLink, Radio, Repeat, Timer, Zap } from "lucide-react";
import { useMemo } from "react";
import type { StoredEvent, ToolResultBlock, ToolUseBlock } from "../../../../src/core/types.ts";
import { auto, isLive, openSession, useAuto, type AgentRecord } from "../../lib/automation.ts";
import { reportError, useStore } from "../../lib/store.ts";
import { cn } from "../../lib/utils.ts";
import { Markdown } from "../Markdown.tsx";
import { AgentStatus, IconButton, STATUS_LABEL, StopIcon } from "./bits.tsx";

export const AGENT_TOOLS = new Set(["Agent", "spawn_agent"]);
export const SYSTEM_INPUT = new Set(["task", "subagent", "wait", "loop", "steer", "harness", "wake"]);

type Report = { id: string; title: string; status: AgentRecord["status"]; text: string };

function reports(text: string): Report[] {
  const out: Report[] = [];
  const re = /<subagent_result agent_id="([^"]*)" title="([^"]*)" status="([^"]*)">\n?([\s\S]*?)\n?<\/subagent_result>/g;
  for (const m of text.matchAll(re)) out.push({ id: m[1]!, title: m[2]!, status: m[3] as Report["status"], text: m[4]!.replace(/&lt;/g, "<") });
  return out;
}

function wakes(text: string) {
  const out: { label: string; body: string }[] = [];
  const re = /<wait_fired id="[^"]*" kind="([^"]*)" outcome="([^"]*)">\n?([\s\S]*?)\n?<\/wait_fired>|<monitor_event id="[^"]*" batch="(\d+)"[^>]*>\n?([\s\S]*?)<\/monitor_event>/g;
  for (const m of text.matchAll(re)) {
    if (m[4]) out.push({ label: `monitor event ${m[4]}`, body: m[5]!.replace(/&lt;/g, "<").trimEnd() });
    else out.push({ label: m[2] === "fired" ? `${m[1]} fired` : m[2] === "timeout" ? `${m[1]} timed out` : `${m[1]} ${m[2]}`, body: m[3]!.replace(/&lt;/g, "<") });
  }
  return out;
}

// One line for the automation tools' cards.
export function toolSummary(name: string, input: any): string | undefined {
  switch (name) {
    case "WaitFor": case "wait_for":
      return input.kind === "timer" ? `timer ${input.seconds ?? ""}s${input.note ? ` · ${input.note}` : ""}` : `${input.kind} ${input.path ?? input.url ?? input.pid ?? ""}${input.match ? ` /${input.match}/` : ""}`;
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
    default:
      return undefined;
  }
}

function Shell({ icon: Icon, label, sub, children, testid, defaultOpen }: { icon: typeof Bot; label: string; sub?: string; children?: React.ReactNode; testid: string; defaultOpen?: boolean }) {
  return (
    <Collapsible.Root defaultOpen={defaultOpen} className="group/in animate-in rounded-lg border border-dashed border-line-strong bg-sunken/60" data-testid={testid}>
      <Collapsible.Trigger className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-caption text-muted outline-none hover:text-fg">
        <Icon className="size-3.5 shrink-0 text-accent" />
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
  const rs = useMemo(() => reports(text), [text]);
  const ws = useMemo(() => wakes(text), [text]);

  if (rs.length && (kind === "subagent" || kind === "wake")) {
    return (
      <div className="flex flex-col gap-2 animate-in" data-testid="agent-reports">
        {rs.map((r) => (
          <Collapsible.Root key={r.id} className="group/rep rounded-lg border border-line bg-raised shadow-1" data-testid="agent-report">
            <Collapsible.Trigger className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-ui outline-none">
              <CornerDownRight className="size-3.5 shrink-0 text-faint" />
              <AgentStatus status={r.status} />
              <span className="font-medium">{r.title}</span>
              <span className="text-caption text-faint">reported · {STATUS_LABEL[r.status] ?? r.status}</span>
              <ChevronRight className="ml-auto size-3.5 shrink-0 text-faint transition-transform group-data-[open]/rep:rotate-90" />
            </Collapsible.Trigger>
            <Collapsible.Panel className="overflow-hidden border-t border-line px-4 py-3 text-ui"><Markdown text={r.text} /></Collapsible.Panel>
          </Collapsible.Root>
        ))}
      </div>
    );
  }
  if (kind === "wait" || (kind === "wake" && ws.length)) {
    return (
      <Shell icon={kind === "wait" && e.data.outcome === "event" ? Radio : Timer} label={`Woken: ${ws.map((w) => w.label).join(", ") || "a wait ended"}`} testid="wake-notice">
        <pre className="mx-3 mb-3 max-h-60 overflow-auto rounded-lg bg-code p-2.5 font-mono text-caption text-muted whitespace-pre-wrap">{ws.map((w) => w.body).join("\n\n") || text}</pre>
      </Shell>
    );
  }
  if (kind === "loop") {
    return (
      <Shell icon={Repeat} label="Loop run" sub={e.data.loop_name} testid="loop-notice">
        <p className="mx-3 mb-3 whitespace-pre-wrap text-ui text-muted">{text}</p>
      </Shell>
    );
  }
  if (kind === "task") {
    const parentId = sessions[e.session_id]?.parent_id;
    const task = text.includes("Task:\n") ? text.slice(text.lastIndexOf("Task:\n") + 6) : text;
    return (
      <div className="animate-in rounded-lg border border-line bg-raised shadow-1 px-4 py-3" data-testid="task-notice">
        <div className="flex items-center gap-2 text-caption text-muted">
          <Bot className="size-3.5 text-accent" /> Task from
          {parentId ? (
            <button type="button" onClick={() => openSession(parentId)} className="flex items-center gap-1 font-medium text-fg hover:text-accent">
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

function resultText(r?: ToolResultBlock): string {
  if (!r) return "";
  return typeof r.content === "string" ? r.content : r.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
}

// The card of an Agent / spawn_agent call: the child's live state, open, stop.
export function AgentCall({ use, result, live }: { use: ToolUseBlock; result?: ToolResultBlock; live?: boolean }) {
  const input: any = use.input ?? {};
  const out = resultText(result);
  const agents = useAuto((s) => s.agents);
  const title = String(input.description ?? input.message ?? input.prompt ?? "").split("\n")[0]!.slice(0, 80);
  const agent = useMemo(() => {
    const id = out.match(/agent[_ ](?:id=")?([0-9a-f]{12})|"agent_id":"([0-9a-f]{12})"/);
    const byId = id ? agents[id[1] ?? id[2]!] : undefined;
    if (byId) return byId;
    return Object.values(agents).filter((a) => a.title === title).sort((a, b) => b.created - a.created)[0];
  }, [agents, out, title]);
  const type = input.subagent_type ?? input.agent_type ?? "general-purpose";
  const report = agent && !isLive(agent) ? agent.result : undefined;

  return (
    <Collapsible.Root className="group/agent animate-in rounded-lg border border-line bg-raised shadow-1" data-testid="agent-call">
      <div className="flex items-center gap-2.5 px-3 py-2 text-ui">
        <span className="grid size-6 shrink-0 place-items-center rounded-md bg-accent-soft text-accent"><Bot className="size-3.5" /></span>
        <span className="font-medium shrink-0">Agent</span>
        <span className="shrink-0 rounded bg-panel px-1.5 py-px text-micro text-muted">{type}</span>
        <span className="min-w-0 truncate text-muted">{agent?.title ?? title}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {agent ? (
            <>
              <AgentStatus status={agent.status} />
              <span className="text-micro text-faint" data-testid="agent-call-status">{STATUS_LABEL[agent.status]}{agent.background && isLive(agent) ? " in background" : ""}</span>
              {isLive(agent) && <IconButton title="Stop agent" danger onClick={() => auto.stopAgent(agent).catch(reportError)} testid="agent-call-stop"><StopIcon /></IconButton>}
              <IconButton title="Open the agent's session" onClick={() => openSession(agent.session_id)} testid="agent-call-open"><ExternalLink className="size-3.5" /></IconButton>
            </>
          ) : (
            live && <span className="size-1.5 rounded-full bg-brass animate-pulse-dot" />
          )}
          <Collapsible.Trigger className="grid size-6 place-items-center rounded-md text-faint outline-none hover:bg-hover hover:text-fg" aria-label="Details">
            <ChevronRight className="size-3.5 transition-transform group-data-[open]/agent:rotate-90" />
          </Collapsible.Trigger>
        </span>
      </div>
      <Collapsible.Panel className={cn("overflow-hidden border-t border-line")}>
        <div className="px-3 pt-2.5 text-micro font-medium uppercase tracking-[0.06em] text-faint">Task</div>
        <p className="px-3 pt-1 text-ui whitespace-pre-wrap text-muted">{input.prompt ?? input.message}</p>
        {(report || out) && (
          <>
            <div className="px-3 pt-3 text-micro font-medium uppercase tracking-[0.06em] text-faint">Report</div>
            <div className="px-3 pt-1 pb-3 text-ui"><Markdown text={report ?? out} /></div>
          </>
        )}
        {!report && !out && <div className="h-2.5" />}
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}
