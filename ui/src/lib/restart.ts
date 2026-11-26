// A restart of Keel asked from the page: what it does to the turns there are
// now, said before it is confirmed. A turn that works stops at its next step
// (a reply on its way is finished first) and goes on after the restart; a
// turn that only waits on the owner (an approval, a question, a plan) is not
// waited for, and still waits for them after the restart. A command that runs
// in a terminal the daemon holds (a tty) ends with it.
import { confirmAction } from "../components/Confirm.tsx";
import { registerCommand } from "./keys.ts";
import { api, reportError } from "./store.ts";
import { tipSay } from "./tips.ts";

type Turns = { running: string[]; waiting?: string[]; terminals?: number };

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
  const t = st.terminals ?? 0;
  const tty = t ? `${t === 1 ? "1 command runs" : `${t} commands run`} in a terminal and ${t === 1 ? "ends" : "end"} with the restart.` : "";
  const rest = [wait, tty].filter(Boolean).join(" ");
  if (!working.length) return `No turn is working.${rest ? ` ${rest}` : ""} The page reconnects by itself.`;
  return `${turns(working.length)} ${working.length === 1 ? "is" : "are"} working. New work waits; working turns stop at their next step and go on after the restart.${rest ? ` ${rest}` : ""}`;
}

// What a restart would cut: turns that work, and commands in a terminal.
const cost = (st: Turns) => turnsOf(st).working.length + (st.terminals ?? 0);

// Asks, then restarts. `reason`: who asked, a few words for the daemon's log. A restart that cuts
// work (a turn is working, a command runs in a terminal) opens on Cancel, as a dialog that costs
// something does (Confirm.tsx); with nothing to cut it costs nothing, and Enter restarts. What the
// answer was given for is read again as it is given: work that started while the question stood is
// asked about again, on Cancel, before anything restarts.
export async function askRestart(st: Turns, reason: string) {
  let asked = st;
  let draining = false;
  const ok = await confirmAction({
    title: "Restart Keel?", body: restartBody(asked), action: "Restart", careful: cost(asked) > 0,
    recheck: async () => {
      const now = await api<Turns & { draining?: unknown }>("/api/daemon");
      draining = !!now.draining;
      if (draining || cost(now) <= cost(asked)) return null;
      asked = now;
      return { body: restartBody(now) };
    },
  });
  if (!ok) return;
  if (draining) return tipSay(null, "Keel is already restarting or stopping", 2400);
  await api("/api/drain", { method: "POST", body: JSON.stringify({ restart: true, reason }) });
}

// The same from Search and commands, with the turns as the daemon counts them now.
registerCommand({
  id: "restart", label: "Restart Keel", group: "General", words: "restart daemon reload relaunch",
  run: () => void api<Turns & { draining: unknown }>("/api/daemon")
    .then((st) => (st.draining ? tipSay(null, "Keel is already restarting or stopping", 2400) : askRestart(st, "asked from Search and commands")))
    .catch(reportError),
});
