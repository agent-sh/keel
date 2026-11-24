// Small fleet pieces used across the workbench: the machine a session's tools
// run on (header chip, tool row badge), and the machine a new session starts on.
import { OFFLINE } from "../../../src/core/state-words.ts";
import { Popover } from "@base-ui/react/popover";
import { ArrowRight, Check, ChevronDown, ChevronLeft, CloudOff, Cpu, Folder, FolderGit2, History, RefreshCw, Server, Wand2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { Session } from "../../../src/core/types.ts";
import { splitId } from "../lib/fleet-ids.ts";
import { fleet, machineName, setNewMachine, useFleet, type RemoteDirs } from "../lib/fleet.ts";
import { useStore } from "../lib/store.ts";
import { api, onFeature, reportError, failed } from "../lib/store.ts";
import { cn } from "../lib/utils.ts";
import { popupClass } from "./ui.tsx";
import { useWhere, WhereBody, whereStyle } from "./Where.tsx";
import { Seg } from "./Seg.tsx";

// Names and one-line summaries of the fleet's tools on their rows.
export const FLEET_LABEL: Record<string, string> = { keel__session_send: "Message", keel__sessions_list: "Sessions", keel__machines_list: "Machines", keel__send_files: "Send files" };
export function fleetSummary(name: string, input: any): string | undefined {
  if (name === "keel__session_send") return `to ${input.to ?? "?"}${input.wake === false ? " (queued)" : ""}: ${String(input.text ?? "").slice(0, 120)}`;
  if (name === "keel__sessions_list") return input.machine ? `on ${input.machine}` : "every machine";
  if (name === "keel__machines_list") return "the fleet";
  if (name === "keel__send_files") return `${(Array.isArray(input.paths) ? input.paths : []).join(", ")} to ${input.agent_id ?? "?"}`;
  return undefined;
}

const dot = (colour?: string) => <span className="size-1.5 shrink-0 rounded-full bg-accent" style={colour ? { background: colour } : undefined} />;

type Handoff = {
  state: "running" | "done" | "failed"; carry: "git" | "none"; from: { machine: string }; to: { machine: string; cwd?: string };
  steps: { name: string; state: string; detail?: string }[]; summary?: string; error?: string; started_ms?: number;
  interrupted?: boolean; // closed by the daemon that started after the one that ran it
  details?: string[]; // what a cut move kept: folded under the sentence
};

const STEP_LABEL: Record<string, string> = { interrupt: "Stop the turn", snapshot: "Snapshot the folder", transfer: "Send what is missing", worktree: "Put it in place", switch: "Switch" };

// Where a session's tools run, in the header: the machine, and moving the
// session to another one with its git state. A session of another daemon is
// shown as "remote" and moves from that daemon.
export function MachineChip({ session }: { session: Session }) {
  const machines = useFleet((s) => s.machines);
  useFleet((s) => s.view.length);
  const [open, setOpen] = useState(false);
  const [carry, setCarry] = useState<"git" | "none">("git");
  const [h, setH] = useState<Handoff | null>(null);
  const [err, setErr] = useState("");
  // A turn at work is cut by a move: the owner moves now (it is cut) or when it ends (it is not).
  const [when, setWhen] = useState<"now" | "turn_end">("turn_end");
  const [waiting, setWaiting] = useState<{ machine: string; since: number } | null>(null);
  const working = session.phase === "working";
  const lives = splitId(session.id)?.machine;
  const runs = session.machine ?? undefined;
  const id = lives ?? runs;
  const others = machines.filter((m) => m.source !== "local" && m.enabled && m.workspace_root && m.id !== runs);
  // A session whose tools run on another machine comes back here before it
  // goes to a third (the daemon refuses anything else): from there the other
  // machines are listed, with why, and are not offered as a move.
  const targets = runs ? [] : others;
  const later = runs ? others : [];
  const where = useWhere({ machine: id });
  useEffect(() => {
    if (lives) return;
    api<{ handoff: Handoff | null; waiting?: { machine: string; since: number } | null }>(`/api/sessions/${session.id}/handoff`).then((r) => { setH(r.handoff); setWaiting(r.waiting ?? null); }).catch(reportError);
    // A move's frames come milliseconds apart, with the session's own frame between them, and each
    // resizes the chip or the popup under it. The frame is rendered as it arrives: a state update
    // left pending here is flushed by the popup's positioner inside its ResizeObserver callback,
    // which resizes what the browser is in the middle of reporting ("ResizeObserver loop" notices).
    return onFeature({ frame: (f) => {
      if (f.session_id !== session.id) return;
      if (f.name === "handoff_progress") flushSync(() => setH(f.data));
      else if (f.name === "handoff_waiting") flushSync(() => setWaiting(f.data));
    } });
  }, [session.id, lives]);
  if (!id && !others.length) return null;
  const name = id ? machineName(id) : machines.find((m) => m.source === "local")?.name ?? "this machine";
  // Elsewhere: the same tag as the rows (Where.tsx), with whether it answers.
  const chip = where ? (
    <>
      <WhereBody w={where} />
      {lives && <span className="text-faint">remote</span>}
      {h?.state === "running" && <span className="size-1.5 rounded-full bg-brass animate-pulse-dot" />}
    </>
  ) : (
    // Here: its name says nothing the page does not, so the bar shows the machine's glyph and keeps the
    // name for the tooltip and the reader. The move is still one press away.
    <>
      <Server aria-hidden="true" className="size-3.5" />
      <span className="sr-only">Runs on {name}</span>
      {h?.state === "running" && <span className="size-1.5 rounded-full bg-brass animate-pulse-dot" />}
    </>
  );
  const cls = where
    ? "k-where k-where-chip inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full border border-line bg-sunken px-2 text-caption text-muted"
    : "inline-flex h-ctl-md shrink-0 items-center gap-1 rounded-md px-1.5 text-faint hover:bg-hover";
  const tag = where ? { "data-machine": where.id, "data-reach": where.reach, style: whereStyle(where.colour) } : {};
  if (lives) return <span data-testid="machine-chip" title={`This session lives on ${name}'s daemon; you see and drive it through the link.${where?.reach === "offline" ? ` ${name} does not answer now.` : ""}`} className={cls} {...tag}>{chip}</span>;
  const move = async (to: string) => {
    setErr("");
    try {
      const r = await api<{ handoff: Handoff; waiting?: { machine: string; since: number } }>(`/api/sessions/${session.id}/handoff`, { method: "POST", body: JSON.stringify({ machine_id: to, carry, when: working ? when : "now" }) });
      if (r.waiting) return setWaiting(r.waiting);
      // The answer is the move as it started. A quick move's progress frames
      // can be here before it: they are newer and stay.
      setH((cur) => (cur?.started_ms !== undefined && cur.started_ms === r.handoff.started_ms ? cur : r.handoff));
    }
    catch (e) { setErr(failed(e, { at: "Fleet" })); }
  };
  // A machine that does not answer is listed, marked, and not a move.
  const dests = [...(runs ? [{ id: "local", name: machines.find((m) => m.source === "local")?.name ?? "this machine", sub: "back here", off: false }] : []), ...targets.map((m) => ({ id: m.id, name: m.name, sub: m.state === "offline" ? OFFLINE : m.workspace_root!, off: m.state === "offline" }))];
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger data-testid="machine-chip" title={`Its tools run on ${name}, in ${session.workspace}${where?.reach === "offline" ? `; ${name} does not answer now` : ""}`} className={cn(cls, "hover:text-fg data-popup-open:border-line-strong")} {...tag}>{chip}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={6} align="end" className="z-50">
          <Popover.Popup className={cn(popupClass, "w-[min(24rem,calc(100vw-1rem))] p-0")} data-testid="move-popup">
            <div className="border-b border-line px-3.5 py-3">
              <div className="text-ui font-medium">Runs on {name}</div>
              <div className="truncate font-mono text-micro text-faint" title={session.workspace}>{session.workspace}</div>
            </div>
            {waiting && (
              <div className="flex items-start gap-2 border-b border-line px-3.5 py-2.5" data-testid="move-waiting">
                <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-brass animate-pulse-dot" />
                <p className="min-w-0 flex-1 text-caption leading-snug text-fg">Moves to {waiting.machine} when the turn ends.<span className="block text-muted">Until then it works here; a restart of Keel calls the move off.</span></p>
                <button type="button" data-testid="move-waiting-cancel" onClick={() => api(`/api/sessions/${session.id}/handoff`, { method: "DELETE" }).then(() => setWaiting(null), (e) => setErr(failed(e, { at: "Fleet" })))}
                  className="h-6 shrink-0 rounded-md px-2 text-caption text-muted hover:bg-hover hover:text-fg">Call off</button>
              </div>
            )}
            {working && !waiting && h?.state !== "running" && dests.length > 0 && (
              <div className="border-b border-line px-3.5 py-2.5" data-testid="move-working">
                <p className="text-caption leading-snug text-fg">A turn is at work. Moving now stops it, and it does not go on there by itself.</p>
                <Seg className="mt-2" label="When it moves" value={when} onChange={setWhen} options={[{ value: "turn_end", label: "when the turn ends", testid: "move-when-end" }, { value: "now", label: "now, stopping the turn", testid: "move-when-now" }]} />
              </div>
            )}
            {dests.length > 0 && (
              <div className="p-1.5">
                <div className="flex items-center px-2 pb-1.5 pt-1 k-label">
                  Move it to
                  <Seg className="ml-auto" label="What travels" value={carry} onChange={setCarry} options={[{ value: "git", label: "with its git state" }, { value: "none", label: "place only" }]} />
                </div>
                {dests.map((d) => (
                  <button key={d.id} type="button" data-testid="move-to" data-machine={d.id} data-offline={d.off || undefined} title={d.off ? `${d.name} does not answer now` : undefined} disabled={h?.state === "running" || !!waiting || d.off} onClick={() => move(d.id)} className="flex h-11 w-full items-center gap-2.5 rounded-md px-2.5 text-left hover:bg-hover disabled:opacity-50 disabled:hover:bg-transparent">
                    {d.id === "local" ? <Cpu className="size-4 shrink-0 text-faint" /> : <Server className="size-4 shrink-0 text-faint" />}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-ui font-medium">{d.name}</span>
                      <span className="block truncate font-mono text-micro text-faint">{d.sub}</span>
                    </span>
                    <ArrowRight className="size-3.5 text-faint" />
                  </button>
                ))}
              </div>
            )}
            {later.length > 0 && (
              <div className="border-t border-line p-1.5" data-testid="move-later">
                <div className="px-2 pb-1 pt-1 k-label">After it is back here</div>
                {later.map((m) => (
                  <div key={m.id} data-testid="move-unavailable" data-machine={m.id} data-offline={m.state === "offline" || undefined} aria-disabled="true" className="flex h-11 items-center gap-2.5 px-2.5 text-faint">
                    <Server className="size-4 shrink-0" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-ui font-medium">{m.name}</span>
                      <span className="block truncate font-mono text-micro">{m.state === "offline" ? OFFLINE : m.workspace_root}</span>
                    </span>
                  </div>
                ))}
                <p className="px-2 pb-1.5 pt-1 text-caption leading-snug text-muted">
                  A session goes to another machine from this one. Move it back here first, then to {later.length === 1 ? later[0]!.name : "one of these"}.
                </p>
              </div>
            )}
            {err && <div className="px-3.5 pb-3 text-caption text-danger">{err}</div>}
            {h && (
              <div className="border-t border-line px-3.5 py-3" data-testid="move-progress" data-state={h.state} data-interrupted={h.interrupted || undefined}>
                <div className="mb-2 text-caption text-muted">{h.state === "running" ? `Moving to ${h.to.machine}` : h.state === "done" ? `Last move: ${h.from.machine} to ${h.to.machine}` : h.interrupted ? `The move to ${h.to.machine} was cut by a restart` : `The move to ${h.to.machine} failed`}</div>
                <ol className="flex flex-col gap-1">
                  {h.steps.map((st) => (
                    <li key={st.name} className="flex items-center gap-2 text-caption">
                      <span className={cn("grid size-4 place-items-center rounded-full", st.state === "done" ? "bg-ok text-bg" : st.state === "failed" ? "bg-danger text-bg" : st.state === "running" ? "bg-brass-soft" : "bg-sunken")}>
                        {st.state === "done" ? <Check className="size-2.5" /> : st.state === "running" ? <span className="size-1.5 rounded-full bg-brass animate-pulse-dot" /> : null}
                      </span>
                      <span className={cn(st.state === "skipped" || st.state === "pending" ? "text-faint" : "text-fg")}>{STEP_LABEL[st.name] ?? st.name}</span>
                      {st.state === "skipped" && <span className="text-micro text-faint">skipped</span>}
                    </li>
                  ))}
                </ol>
                {(h.summary || h.error) && <p className={cn("mt-2 text-caption leading-snug", h.error ? "text-danger" : "text-muted")}>{h.error ?? h.summary}</p>}
                {h.details && h.details.length > 0 && (
                  <details className="mt-2 rounded-md border border-line bg-sunken" data-testid="move-details">
                    <summary className="cursor-pointer select-none px-2.5 py-1.5 text-caption text-muted">What it kept</summary>
                    <ul className="flex flex-col gap-1.5 border-t border-line px-2.5 py-2 text-caption leading-snug text-muted">
                      {h.details.map((d) => <li key={d} className="break-words">{d}</li>)}
                    </ul>
                  </details>
                )}
              </div>
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

// "on <machine>" on a tool row that ran on another machine.
export function MachineBadge({ sessionId, callId }: { sessionId?: string; callId: string }) {
  const step = useFleet((s) => (sessionId ? s.steps[sessionId]?.[callId] : undefined));
  useEffect(() => {
    // The rows of one session share one read; only the row that started it reports its failure.
    if (sessionId && !(sessionId in fleet.stepsAsked)) fleet.ensureSteps(sessionId).catch(reportError);
  }, [sessionId]);
  if (!step) return null;
  return (
    <span data-testid="tool-machine" className="inline-flex items-center gap-1 rounded-full bg-sunken px-1.5 py-px text-muted">
      <Server className="size-3" /> {step.name}
    </span>
  );
}

// The machine a new session starts on: this one, or a linked one with a granted directory.
export function MachinePicker() {
  const machines = useFleet((s) => s.machines);
  const chosen = useFleet((s) => s.newMachine);
  const rules = useFleet((s) => s.rules);
  const [open, setOpen] = useState(false);
  const usable = machines.filter((m) => m.source !== "local" && m.enabled && m.workspace_root);
  // The pick stays shown when it cannot be used now (offline, removed): it is still where a send would go.
  const pick = useNewMachine();
  if (!usable.length && !rules.length && !pick.blocked) return null;
  const cur = chosen === "auto" && rules.length ? { id: "auto", name: "Auto", workspace_root: "placement rules" }
    : pick.blocked ? { id: pick.id, name: pick.blocked.machine ? pick.blocked.name : "Removed machine", workspace_root: "" }
    : usable.find((m) => m.id === chosen);
  const local = machines.find((m) => m.source === "local");
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        data-testid="machine-picker"
        data-blocked={pick.blocked ? "true" : undefined}
        title={pick.blocked ? `${pick.blocked.name} ${pick.blocked.why}` : undefined}
        className="k-chip-pick"
      >
        {pick.blocked ? <CloudOff className="text-brass" /> : cur ? <Server /> : <Cpu />}
        <span className="k-chip-pick-name">{cur?.name ?? local?.name ?? "This machine"}</span>
        {cur?.workspace_root && <span className="k-chip-pick-sub max-sm:hidden">{cur.workspace_root}</span>}
        <ChevronDown className="k-chip-pick-more" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={6} align="start" className="z-50">
          <Popover.Popup className={cn(popupClass, "w-80")} data-testid="machine-popup">
            <div className="px-2.5 pb-1 pt-2 k-label">Where its tools run</div>
            {[
              { id: "", name: local?.name ?? "This machine", sub: "this machine", state: "ready" },
              ...usable.map((m) => ({ id: m.id, name: m.name, sub: m.workspace_root!, state: m.state })),
              ...(rules.length ? [{ id: "auto", name: "Auto", sub: `by your ${rules.length} placement rule${rules.length > 1 ? "s" : ""}`, state: "ready" }] : []),
            ].map((o) => (
              <button
                key={o.id || "local"}
                type="button"
                data-testid="machine-option"
                data-machine={o.id || "local"}
                disabled={o.state === "offline"}
                onClick={() => { setNewMachine(o.id); setOpen(false); }}
                className="flex h-11 w-full items-center gap-2.5 rounded-md px-2.5 text-left hover:bg-hover disabled:opacity-50"
              >
                {o.id === "auto" ? <Wand2 className="size-4 shrink-0 text-faint" /> : o.id ? <Server className="size-4 shrink-0 text-faint" /> : <Cpu className="size-4 shrink-0 text-faint" />}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-ui font-medium">{o.name}</span>
                  <span className="block truncate font-mono text-micro text-faint">{o.state === "offline" ? OFFLINE : o.sub}</span>
                </span>
                {(chosen === o.id || (!cur && !o.id)) && <Check className="size-4 text-accent" />}
              </button>
            ))}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

// The machine picked for a new session ("" is this one), and why it cannot
// take one now. A pick that cannot be used stays the pick: the start box says
// so and sends nothing, and never starts the session on this machine instead.
export type NewMachine = { id: string; blocked?: { machine?: string; name: string; why: string } };
export function useNewMachine(): NewMachine {
  const machines = useFleet((s) => s.machines);
  const chosen = useFleet((s) => s.newMachine);
  const rules = useFleet((s) => s.rules.length);
  if (!chosen) return { id: "" };
  // Before the first listing nothing is known (no machine, no rule): the pick
  // goes to the daemon as it is, and the daemon answers for it.
  if (chosen === "auto") return { id: rules || !machines.length ? "auto" : "" };
  const m = machines.find((x) => x.id === chosen);
  if (!m) return machines.length ? { id: chosen, blocked: { name: "The machine you picked", why: "is no longer in the fleet" } } : { id: chosen };
  if (!m.workspace_root) return { id: chosen, blocked: { machine: m.id, name: m.name, why: "has no granted directory" } };
  if (m.state === "offline") return { id: chosen, blocked: { machine: m.id, name: m.name, why: `is ${OFFLINE.toLowerCase()}` } };
  return { id: chosen };
}

// The blocked pick, said under the pickers: which machine, that nothing is
// sent, and the two ways on (ask it again, or start on this machine).
export function MachineBlocked({ blocked }: { blocked: NonNullable<NewMachine["blocked"]> }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const retry = async () => {
    setBusy(true);
    setErr("");
    try { await fleet.check(blocked.machine!); } catch (e) { setErr(failed(e, { at: "MachineBlocked" })); } finally { setBusy(false); }
  };
  const button = "inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-caption font-medium disabled:opacity-50";
  return (
    <div role="status" data-testid="machine-blocked" data-machine={blocked.machine} className="mb-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-brass/40 bg-brass-soft/50 py-2 pl-3 pr-2 text-caption">
      <CloudOff className="size-4 shrink-0 text-brass" />
      <span className="min-w-0 flex-1 basis-64 leading-snug text-muted">
        <span className="font-medium text-fg">{blocked.name}</span> {blocked.why}. Nothing is sent, and nothing starts on this machine instead: your message stays here.
        {err && <span className="block text-danger">{err}</span>}
      </span>
      <span className="flex shrink-0 gap-1">
        {blocked.machine && (
          <button type="button" data-testid="machine-retry" disabled={busy} onClick={retry} className={cn(button, "border border-line bg-raised text-fg shadow-1 hover:border-line-strong")}>
            <RefreshCw className={cn("size-3.5", busy && "animate-spin")} /> {busy ? "Asking" : "Try again"}
          </button>
        )}
        <button type="button" data-testid="machine-start-here" onClick={() => setNewMachine("")} className={cn(button, "text-muted hover:bg-hover hover:text-fg")}>
          <Cpu className="size-3.5" /> Start here
        </button>
      </span>
    </div>
  );
}

// The folder a new session works in on an ssh machine: its recent folders
// there, then browsing inside the directory granted there (over ssh).
export function RemoteFolderPicker({ machine, value, onChange }: { machine: string; value: string; onChange: (path: string) => void }) {
  const m = useFleet((s) => s.machines.find((x) => x.id === machine));
  const sessions = useStore((s) => s.sessions);
  const [open, setOpen] = useState(false);
  const [browse, setBrowse] = useState<RemoteDirs | null>(null);
  const [err, setErr] = useState("");
  const root = m?.workspace_root ?? "";
  const shown = value || root;
  const recent = [...new Set(Object.values(sessions).filter((s) => s.machine === machine && !s.archived).sort((a, b) => b.updated - a.updated).map((s) => s.workspace))].slice(0, 5);
  const home = m?.facts?.home;
  const rel = (p: string) => (home && p.startsWith(home) ? `~${p.slice(home.length)}` : p);
  // Answers come back in any order: only the one to the newest question is
  // shown, and closing the popup (or picking) leaves no question open.
  const asked = useRef(0);
  const go = (path?: string) => {
    const mine = ++asked.current;
    setErr("");
    fleet.dirs(machine, path).then((r) => { if (mine === asked.current) setBrowse(r); }, (e) => { if (mine === asked.current) setErr(failed(e, { at: "RemoteFolderPicker" })); });
  };
  const close = () => { asked.current++; setBrowse(null); setErr(""); };
  const pick = (p: string) => { onChange(p); setOpen(false); close(); };
  return (
    <Popover.Root open={open} onOpenChange={(o) => { setOpen(o); if (o && !recent.length) go(shown); if (!o) close(); }}>
      <Popover.Trigger data-testid="remote-folder-picker" title={`${shown} on ${m?.name ?? machine}`} className="k-field inline-flex max-w-full items-center gap-1.5 text-muted hover:text-fg data-popup-open:text-fg">
        <Folder className="size-3.5 shrink-0 text-accent" />
        <span className="truncate font-medium text-fg">{shown.split("/").pop() || "Folder"}</span>
        <span className="hidden truncate font-mono text-micro text-faint sm:inline">{shown.slice(0, shown.lastIndexOf("/"))}</span>
        <ChevronDown className="size-3.5 shrink-0 opacity-60" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={6} align="start" className="z-50">
          <Popover.Popup className={cn(popupClass, "w-[min(26rem,calc(100vw-1.5rem))] p-0")} data-testid="remote-folder-popup">
            {!browse && !recent.length ? (
              !err && <p className="k-empty px-3 py-4" data-testid="remote-reading">Reading the folders on {m?.name}.</p>
            ) : !browse ? (
              <div className="p-1">
                <div className="flex items-center gap-1.5 px-2.5 pb-1 pt-2 k-label"><History className="size-3" /> Recent on {m?.name}</div>
                {recent.map((p) => (
                  <button key={p} type="button" onClick={() => pick(p)} className={cn("flex h-10 w-full items-center gap-2.5 rounded-md px-2.5 text-left hover:bg-hover", p === shown && "bg-hover")}>
                    <Folder className="size-4 shrink-0 text-faint" />
                    <span className="min-w-0"><span className="block truncate text-ui font-medium">{p.split("/").pop()}</span><span className="block truncate font-mono text-micro text-faint">{p}</span></span>
                  </button>
                ))}
                <div className="my-1 h-px bg-line" />
                <button type="button" data-testid="remote-browse" onClick={() => go(shown)} className="flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-ui text-muted hover:bg-hover hover:text-fg"><Folder className="size-4 text-faint" /> Browse folders on {m?.name}</button>
              </div>
            ) : (
              <div className="flex max-h-[min(26rem,70vh)] flex-col">
                <div className="flex items-center gap-1 border-b border-line p-1.5">
                  <button type="button" aria-label="Up one folder" disabled={!browse.parent} onClick={() => browse.parent && go(browse.parent)} className="grid size-7 place-items-center rounded-sm text-faint hover:bg-hover hover:text-fg disabled:opacity-30"><ChevronLeft className="size-4" /></button>
                  <span className="min-w-0 flex-1 truncate font-mono text-caption text-muted" title={browse.path}>{rel(browse.path)}</span>
                  <button type="button" data-testid="remote-use-folder" onClick={() => pick(browse.path)} className="h-7 shrink-0 rounded-sm bg-accent px-2.5 text-caption font-medium text-accent-fg hover:bg-accent-hover">Use this folder</button>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto p-1">
                  {browse.dirs.length === 0 && <p className="k-empty px-3 py-4">No folders inside.</p>}
                  {browse.dirs.map((d) => (
                    <button key={d.path} type="button" data-testid="remote-dir" onClick={() => go(d.path)} onDoubleClick={() => pick(d.path)} className="flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-ui hover:bg-hover">
                      {d.is_git ? <FolderGit2 className="size-4 shrink-0 text-accent" /> : <Folder className="size-4 shrink-0 text-faint" />}
                      <span className="truncate">{d.name}</span>
                      {d.is_git && <span className="ml-auto text-micro text-faint">git</span>}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {err && <p className="border-t border-line px-3 py-2 text-caption text-danger">{err}</p>}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
