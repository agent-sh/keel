// Small fleet pieces used across the workbench: the machine a session's tools
// run on (header chip, tool row badge), and the machine a new session starts on.
import { Popover } from "@base-ui/react/popover";
import { Check, ChevronDown, Cpu, Server, Wand2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { Session } from "../../../src/core/types.ts";
import { splitId } from "../lib/fleet-ids.ts";
import { fleet, machineColour, machineName, setNewMachine, useFleet } from "../lib/fleet.ts";
import { reportError } from "../lib/store.ts";
import { cn } from "../lib/utils.ts";
import { popupClass } from "./ui.tsx";

// Names and one-line summaries of the fleet's tools on their rows.
export const FLEET_LABEL: Record<string, string> = { keel__session_send: "Message", keel__sessions_list: "Sessions", keel__machines_list: "Machines" };
export function fleetSummary(name: string, input: any): string | undefined {
  if (name === "keel__session_send") return `to ${input.to ?? "?"}${input.wake === false ? " (queued)" : ""}: ${String(input.text ?? "").slice(0, 120)}`;
  if (name === "keel__sessions_list") return input.machine ? `on ${input.machine}` : "every machine";
  if (name === "keel__machines_list") return "the fleet";
  return undefined;
}

const dot = (colour?: string) => <span className="size-1.5 shrink-0 rounded-full bg-accent" style={colour ? { background: colour } : undefined} />;

// "on <machine>" in the session header, for a session of another daemon or one
// whose tools run on another machine.
export function MachineChip({ session }: { session: Session }) {
  useFleet((s) => s.machines.length + s.view.length);
  const lives = splitId(session.id)?.machine;
  const runs = session.machine ?? undefined;
  const id = lives ?? runs;
  if (!id) return null;
  const name = machineName(id);
  const title = lives ? `This session lives on ${name}'s daemon; you see and drive it through the link.` : `Its tools run on ${name}, in ${session.workspace}.`;
  return (
    <span data-testid="machine-chip" title={title} className="inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full border border-line bg-sunken px-2 text-caption text-muted">
      {dot(machineColour(id))}
      <span className="font-medium text-fg">{name}</span>
      {lives && <span className="text-faint">remote</span>}
    </span>
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
