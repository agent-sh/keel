// Small fleet pieces used across the workbench: the machine a session's tools
// run on (header chip, tool row badge), and the machine a new session starts on.
import { Popover } from "@base-ui/react/popover";
import { ArrowRight, Check, ChevronDown, Cpu, Server, Wand2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { Session } from "../../../src/core/types.ts";
import { splitId } from "../lib/fleet-ids.ts";
import { fleet, machineColour, machineName, setNewMachine, useFleet } from "../lib/fleet.ts";
import { api, onFeature, reportError, failed } from "../lib/store.ts";
import { cn } from "../lib/utils.ts";
import { popupClass } from "./ui.tsx";

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
  steps: { name: string; state: string; detail?: string }[]; summary?: string; error?: string;
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
  const lives = splitId(session.id)?.machine;
  const runs = session.machine ?? undefined;
  const id = lives ?? runs;
  const targets = machines.filter((m) => m.source !== "local" && m.enabled && m.workspace_root && m.id !== runs);
  useEffect(() => {
    if (lives) return;
    api<{ handoff: Handoff | null }>(`/api/sessions/${session.id}/handoff`).then((r) => setH(r.handoff)).catch(reportError);
    return onFeature({ frame: (f) => { if (f.name === "handoff_progress" && f.session_id === session.id) setH(f.data); } });
  }, [session.id, lives]);
  if (!id && !targets.length) return null;
  const name = id ? machineName(id) : machines.find((m) => m.source === "local")?.name ?? "this machine";
  const chip = (
    <>
      {dot(id ? machineColour(id) : undefined)}
      <span className="font-medium text-fg">{name}</span>
      {lives && <span className="text-faint">remote</span>}
      {h?.state === "running" && <span className="size-1.5 rounded-full bg-brass animate-pulse-dot" />}
    </>
  );
  const cls = "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full border border-line bg-sunken px-2 text-caption text-muted";
  if (lives) return <span data-testid="machine-chip" title={`This session lives on ${name}'s daemon; you see and drive it through the link.`} className={cls}>{chip}</span>;
  const move = async (to: string) => {
    setErr("");
    try { setH((await api<{ handoff: Handoff }>(`/api/sessions/${session.id}/handoff`, { method: "POST", body: JSON.stringify({ machine_id: to, carry }) })).handoff); }
    catch (e) { setErr(failed(e, { at: "Fleet" })); }
  };
  const dests = [...(runs ? [{ id: "local", name: machines.find((m) => m.source === "local")?.name ?? "this machine", sub: "back here" }] : []), ...targets.map((m) => ({ id: m.id, name: m.name, sub: m.workspace_root! }))];
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger data-testid="machine-chip" title={`Its tools run on ${name}, in ${session.workspace}`} className={cn(cls, "hover:text-fg data-popup-open:border-line-strong")}>{chip}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={6} align="end" className="z-50">
          <Popover.Popup className={cn(popupClass, "w-96 p-0")} data-testid="move-popup">
            <div className="border-b border-line px-3.5 py-3">
              <div className="text-ui font-medium">Runs on {name}</div>
              <div className="truncate font-mono text-micro text-faint" title={session.workspace}>{session.workspace}</div>
            </div>
            {dests.length > 0 && (
              <div className="p-1.5">
                <div className="flex items-center px-2 pb-1.5 pt-1 text-micro font-medium text-faint">
                  Move it to
                  <span role="radiogroup" aria-label="What travels" className="ml-auto inline-flex rounded-md border border-line bg-sunken p-0.5">
                    {(["git", "none"] as const).map((c) => (
                      <button key={c} type="button" role="radio" aria-checked={carry === c} onClick={() => setCarry(c)} className={cn("h-5 rounded-sm px-2 text-micro", carry === c ? "bg-raised text-fg shadow-1" : "text-muted")}>
                        {c === "git" ? "with its git state" : "place only"}
                      </button>
                    ))}
                  </span>
                </div>
                {dests.map((d) => (
                  <button key={d.id} type="button" data-testid="move-to" data-machine={d.id} disabled={h?.state === "running"} onClick={() => move(d.id)} className="flex h-11 w-full items-center gap-2.5 rounded-md px-2.5 text-left hover:bg-hover disabled:opacity-50">
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
            {err && <div className="px-3.5 pb-3 text-caption text-danger">{err}</div>}
            {h && (
              <div className="border-t border-line px-3.5 py-3" data-testid="move-progress" data-state={h.state}>
                <div className="mb-2 text-caption text-muted">{h.state === "running" ? `Moving to ${h.to.machine}` : h.state === "done" ? `Last move: ${h.from.machine} to ${h.to.machine}` : `The move to ${h.to.machine} failed`}</div>
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
    if (sessionId && !splitId(sessionId) && !(sessionId in fleet.loadedSteps)) {
      fleet.loadedSteps[sessionId] = true;
      fleet.loadSteps(sessionId).catch(reportError);
    }
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
  if (!usable.length && !rules.length) return null;
  const cur = chosen === "auto" && rules.length ? { id: "auto", name: "Auto", workspace_root: "placement rules" } : usable.find((m) => m.id === chosen);
  const local = machines.find((m) => m.source === "local");
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        data-testid="machine-picker"
        className="inline-flex h-8 items-center gap-1.5 rounded-md border border-line bg-raised px-2.5 text-ui text-muted shadow-1 hover:text-fg data-popup-open:text-fg"
      >
        {cur ? <Server className="size-3.5 text-accent" /> : <Cpu className="size-3.5 text-accent" />}
        <span className="font-medium text-fg">{cur?.name ?? local?.name ?? "This machine"}</span>
        {cur && <span className="hidden truncate font-mono text-micro text-faint sm:inline">{cur.workspace_root}</span>}
        <ChevronDown className="size-3.5 opacity-60" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={6} align="start" className="z-50">
          <Popover.Popup className={cn(popupClass, "w-80")} data-testid="machine-popup">
            <div className="px-2.5 pb-1 pt-2 text-micro font-medium text-faint">Where its tools run</div>
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
                  <span className="block truncate font-mono text-micro text-faint">{o.state === "offline" ? "offline" : o.sub}</span>
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

// The machine chosen for a new session, when it can still be used.
export function useNewMachine(): string {
  const machines = useFleet((s) => s.machines);
  const chosen = useFleet((s) => s.newMachine);
  const rules = useFleet((s) => s.rules.length);
  if (chosen === "auto") return rules ? "auto" : "";
  return machines.some((m) => m.id === chosen && m.workspace_root && m.state !== "offline") ? chosen : "";
}
