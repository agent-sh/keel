// Where a session runs when that is not here: the machine's name on a tag in
// the machine's colour, and whether it answers when it does not. A session of
// this machine carries nothing. The same tag is on every surface that names a
// session (rows, marks, the pane and session headers, the palette).
import { Monitor, Server, ServerOff } from "lucide-react";
import type { CSSProperties } from "react";
import type { Session } from "../../../src/core/types.ts";
import { machineColour, machineName, machineReach, useFleet, type Reach } from "../lib/fleet.ts";
import { OFFLINE } from "../../../src/core/state-words.ts";
import { cn } from "../lib/utils.ts";

const REACH_WORD: Record<Reach["state"], string> = { ok: "", connecting: "Connecting", offline: OFFLINE };

export function useWhere(s: Pick<Session, "machine"> | undefined) {
  const id = s?.machine ?? undefined;
  // Re-read when the machines or their links change.
  useFleet((x) => (id ? `${x.machines.find((m) => m.id === id)?.state}:${x.machines.find((m) => m.id === id)?.daemon?.state}:${x.view.find((m) => m.id === id)?.state}:${x.machines.length}` : ""));
  if (!id) return null;
  const reach = machineReach(id);
  const name = machineName(id) ?? id;
  const colour = machineColour(id);
  const title = `Runs on ${name}${reach.state === "offline" ? `, which does not answer${reach.reason ? `: ${reach.reason}` : ""}` : reach.state === "connecting" ? ", being reached" : ""}`;
  return { id, name, colour, reach: reach.state, title, word: REACH_WORD[reach.state] };
}

export const whereStyle = (colour?: string) => (colour ? ({ "--where": colour } as CSSProperties) : undefined);

// The icon, the name and the reach word; `Where` puts them on a tag, the
// header's machine chip in its own pill.
export function WhereBody({ w }: { w: NonNullable<ReturnType<typeof useWhere>> }) {
  const Icon = w.reach === "offline" ? ServerOff : Server;
  return (
    <>
      <Icon aria-hidden="true" />
      <span className="k-where-name">{w.name}</span>
      {w.word && <span className="k-where-reach" data-testid="where-reach">{w.word}</span>}
    </>
  );
}

export function Where({ s, className, "data-testid": testid = "where" }: { s: Pick<Session, "machine"> | undefined; className?: string; "data-testid"?: string }) {
  const w = useWhere(s);
  if (!w) return null;
  return (
    <span className={cn("k-where", className)} data-testid={testid} data-machine={w.id} data-reach={w.reach} title={w.title} style={whereStyle(w.colour)}>
      <WhereBody w={w} />
    </span>
  );
}

// A pip in the machine's colour, for a place too small for the tag (a folded
// rail's mark). Its name is in the entry's label.
export function WherePip({ s }: { s: Pick<Session, "machine"> }) {
  const w = useWhere(s);
  if (!w) return null;
  return <span className="k-where-pip" data-testid="where" data-machine={w.id} data-reach={w.reach} title={w.title} style={whereStyle(w.colour)} aria-hidden="true" />;
}

// "on devbox" for a label read aloud or a title; nothing for a local session.
export const whereWords = (s: Pick<Session, "machine">) => (s.machine ? ` on ${machineName(s.machine) ?? s.machine}${machineReach(s.machine).state === "offline" ? ` (${OFFLINE.toLowerCase()})` : ""}` : "");

// A list's sessions by where they run: this machine's first, then each other
// machine's by name. One run when every session is here.
export function machineRuns<T extends Pick<Session, "machine">>(list: T[]): { machine?: string; list: T[] }[] {
  const by = new Map<string | undefined, T[]>();
  for (const s of list) (by.get(s.machine ?? undefined) ?? by.set(s.machine ?? undefined, []).get(s.machine ?? undefined)!).push(s);
  const remote = [...by.keys()].filter((k): k is string => k !== undefined).sort((a, b) => (machineName(a) ?? a).localeCompare(machineName(b) ?? b));
  return [...(by.has(undefined) || !remote.length ? [{ machine: undefined, list: by.get(undefined) ?? [] }] : []), ...remote.map((m) => ({ machine: m, list: by.get(m)! }))];
}

// The line between machines in the list: this machine's sessions, then each
// other machine's under its name in its colour, with whether it answers.
export function MachineSep({ machine, count }: { machine?: string; count: number }) {
  const w = useWhere(machine ? { machine } : undefined);
  const Icon = w?.reach === "offline" ? ServerOff : machine ? Server : Monitor;
  return (
    <div className="k-machine-sep" data-testid="machine-sep" data-machine={machine ?? "local"} data-reach={w?.reach} title={w?.title ?? "Sessions on this machine"} style={whereStyle(w?.colour)} role="separator" aria-label={w ? `${w.name}${w.word ? `, ${w.word}` : ""}` : "This machine"}>
      <Icon aria-hidden="true" />
      <span className="k-machine-sep-name">{w?.name ?? "This machine"}</span>
      {w?.word && <span className="k-machine-sep-reach">{w.word}</span>}
      <span className="k-machine-sep-count">{count}</span>
    </div>
  );
}

