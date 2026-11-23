// A restart of Keel asked from the page: what it does to the turns there are
// now, said before it is confirmed. A turn that works gets time to finish; a
// turn that only waits on the owner (an approval, a question, a plan) is not
// waited for, and still waits for them after the restart.
import { confirmAction } from "../components/Confirm.tsx";
import { registerCommand } from "./keys.ts";
import { api, reportError } from "./store.ts";
import { tipSay } from "./tips.ts";

type Turns = { running: string[]; waiting?: string[] };

const turns = (n: number) => `${n} turn${n === 1 ? "" : "s"}`;

// The turns of a status, apart: those that work, and those that wait on the owner.
export function turnsOf(st: Turns): { working: string[]; waiting: string[] } {
  const waiting = st.waiting ?? [];
  return { working: st.running.filter((id) => !waiting.includes(id)), waiting };
}

// What the restart's question says of the turns there are now.
export function restartBody(st: Turns): string {
  const { working, waiting } = turnsOf(st);
  const wait = waiting.length ? `${turns(waiting.length)} ${waiting.length === 1 ? "waits" : "wait"} on you for an answer, and still ${waiting.length === 1 ? "waits" : "wait"} after the restart.` : "";
  if (!working.length) return `No turn is working.${wait ? ` ${wait}` : ""} The page reconnects by itself.`;
  return `${turns(working.length)} ${working.length === 1 ? "is" : "are"} working. New work waits; working turns get two minutes to finish, and any still working then go on after the restart.${wait ? ` ${wait}` : ""}`;
}

// Asks, then restarts. `reason`: who asked, a few words for the daemon's log. A restart that cuts
// work (a turn is working) opens on Cancel, as a dialog that costs something does (Confirm.tsx); with
// no turn working it costs nothing, and Enter restarts.
export async function askRestart(st: Turns, reason: string) {
  const ok = await confirmAction({ title: "Restart Keel?", body: restartBody(st), action: "Restart", careful: turnsOf(st).working.length > 0 });
  if (ok) await api("/api/drain", { method: "POST", body: JSON.stringify({ restart: true, reason }) });
}

// The same from Search and commands, with the turns as the daemon counts them now.
registerCommand({
  id: "restart", label: "Restart Keel", group: "General", words: "restart daemon reload relaunch",
  run: () => void api<Turns & { draining: unknown }>("/api/daemon")
    .then((st) => (st.draining ? tipSay(null, "Keel is already restarting or stopping", 2400) : askRestart(st, "asked from Search and commands")))
    .catch(reportError),
});
