// Where a session runs when that is not here: the machine's name on a tag in
// the machine's colour, and whether it answers when it does not. A session of
// this machine carries nothing. The same tag is on every surface that names a
// session (rows, marks, the pane and session headers, the palette).
import { Server, ServerOff } from "lucide-react";
import type { CSSProperties } from "react";
import type { Session } from "../../../src/core/types.ts";
import { machineColour, machineName, machineReach, useFleet, type Reach } from "../lib/fleet.ts";
import { cn } from "../lib/utils.ts";

const REACH_WORD: Record<Reach["state"], string> = { ok: "", connecting: "connecting", offline: "offline" };

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
export const whereWords = (s: Pick<Session, "machine">) => (s.machine ? ` on ${machineName(s.machine) ?? s.machine}${machineReach(s.machine).state === "offline" ? " (offline)" : ""}` : "");
