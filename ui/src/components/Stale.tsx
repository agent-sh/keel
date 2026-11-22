// What the page says of a state it cannot vouch for, and of its own link.
//
// A state is not current from when the page stopped hearing the daemon until
// it has caught up again (not only until a socket speaks: the rows are true
// once the reads are in), and, for a session of another machine, while that
// machine is out of reach. Such a state carries `as_of` (lib/watch.ts): its
// clocks stop there, a list row writes "as of HH:MM" beside its state word
// itself (Sidebar.tsx), and a pane's head gets the same words from the rule
// here, since a pane is keyed `[data-station]` and another machine's session
// carries the machine's id in front of its own. While the page itself is cut
// off every mark also pales and stops moving. A state the daemon told since
// the loss is current the moment it is in, before the rest of the catch-up:
// the marks here go when the daemon's snapshot of the states is read, and a
// session a frame was quicker for is left out of them until then.
//
// The logo's word is the link's: connected, slow to answer (two asks went
// unanswered), reconnecting, catching up, or the daemon stopping or restarting.
import { useEffect, useState } from "react";
import { drainWords, useDrain } from "../lib/drain.ts";
import { useReach } from "../lib/reach.ts";
import { useStaleSince, useStore } from "../lib/store.ts";
import { clock } from "../lib/utils.ts";
import { useStatesSince, useToldSince } from "../lib/watch.ts";

// A drop this short is a blip (the socket opened again at once and the page caught up): nothing is said.
const AWAY_AFTER_MS = 1_000;

// Since when what the page shows is not current, once that outlasts a blip (null while it is current).
export function useAway(): number | null {
  const since = useStaleSince();
  const [away, setAway] = useState<number | null>(null);
  useEffect(() => {
    if (since === null) return setAway(null);
    const t = setTimeout(() => setAway(since), Math.max(0, since + AWAY_AFTER_MS - Date.now()));
    return () => clearTimeout(t);
  }, [since]);
  return away;
}

// The link in a word, for the logo's tip; `live`: the page hears the daemon and what it shows is current.
export function useLink(): { live: boolean; word: string } {
  const connected = useStore((s) => s.connected);
  const synced = useStore((s) => s.synced);
  const slow = useStore((s) => s.slow);
  const drain = useDrain();
  if (!connected) return { live: false, word: "Reconnecting to the daemon" };
  if (!synced) return { live: false, word: "Catching up with the daemon" };
  if (slow) return { live: true, word: "Keel is slow to answer" };
  // A daemon that is going is heard, and still is not simply connected: it takes no new work.
  if (drain) return { live: true, word: drainWords(drain) };
  return { live: true, word: "Connected to the daemon" };
}

const said = (words: string) => `content: " ${words}"; font-family: var(--font-sans); font-stretch: normal; font-weight: 400; letter-spacing: 0; text-transform: none; white-space: pre; color: var(--muted);`;
// A machine's id is letters and digits (src/fleet/fleet.ts); anything else names no rule.
const plain = (id: string) => /^[A-Za-z0-9]+$/.test(id);

// The marks, as a stylesheet of their own: mounted once, beside the page's band.
export function StaleMarks() {
  const away = useAway();
  const since = useStatesSince();
  const told = useToldSince();
  const unheard = useReach((x) => x.unheard);
  const page = away !== null && since !== null;
  // The sessions told since the loss: their rows and panes say nothing of it.
  const ids = told.filter((id) => /^[A-Za-z0-9-]+$/.test(id));
  const but = (attr: string) => (ids.length ? `:not(${ids.map((id) => `[${attr}="${id}"]`).join(", ")})` : "");
  const row = `.k-row${but("data-session")}`, station = `.k-station${but("data-station")}`;
  const css = page
    ? [
      `${station} .k-station-word::after { ${said(`as of ${clock(away)}`)} }`,
      `:is(${row}, ${station}) .k-mark { opacity: 0.45; animation-play-state: paused; }`,
      `:is(${row}, ${station}) .k-mark::before, :is(${row}, ${station}) .k-mark::after { animation-play-state: paused; }`,
      `:is(${row} .k-row-time[data-live], ${station} .k-station-clock) { color: var(--faint); }`,
    ].join("\n")
    : Object.values(unheard).filter((m) => plain(m.id) && m.since > 0)
      .map((m) => `.k-station[data-station^="${m.id}--"] .k-station-word::after { ${said(`as of ${clock(m.since)}`)} }\n.k-station[data-station^="${m.id}--"] .k-mark { opacity: 0.45; animation-play-state: paused; }`).join("\n");
  if (!css) return null;
  return <style data-testid="stale-marks" data-stale={page ? "page" : "machine"}>{css}</style>;
}
