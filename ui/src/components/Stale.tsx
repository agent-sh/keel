// What the page shows of a state it cannot vouch for. Two cases, one look:
// the page does not hear the daemon (every session, as of the last frame),
// or a machine of the fleet is out of reach (its sessions, as of when it was
// last heard). A state word then reads "as of HH:MM" (", offline" for a
// machine), its mark stops moving and pales, and the clocks stop (the states
// carry `as_of`: lib/watch.ts). And, above the list, a quiet line per machine
// that is out of reach, with its name and since when, and a word when it is
// back: seen without scrolling to the machine's own rows.
//
// The words are put on by one rule here instead of in each view that shows a
// state (rows, pane heads, cards): a row of the list is `[data-session]`, a
// pane `[data-station]`, and another machine's session carries the machine's
// id in front of its own.
import { Server, ServerOff } from "lucide-react";
import { useEffect, useState } from "react";
import { toggleList } from "../lib/rail.ts";
import { BACK_MS, useReach, type Unheard } from "../lib/reach.ts";
import { downSince, useStore } from "../lib/store.ts";
import { clock } from "../lib/utils.ts";

// A drop this short is a blip (the socket opened again at once): nothing is said.
const AWAY_AFTER_MS = 1_000;

// Since when the page has not heard the daemon, once that outlasts a blip (null while it hears it).
export function useAway(): number | null {
  const connected = useStore((s) => s.connected);
  const [away, setAway] = useState<number | null>(null);
  useEffect(() => {
    if (connected) return setAway(null);
    const since = downSince();
    if (since === null) return; // the page's first socket has not opened yet: it is loading
    const t = setTimeout(() => setAway(since), Math.max(0, since + AWAY_AFTER_MS - Date.now()));
    return () => clearTimeout(t);
  }, [connected]);
  return away;
}

const WORDS = ":is(.k-row-state, .k-station-word)::after";
// The rules for the states under `scope` ("" for every state on the page).
function rules(scope: { row: string; pane: string } | null, words: string): string {
  const row = scope ? `.k-row${scope.row}` : ".k-row";
  const pane = scope ? `.k-station${scope.pane}` : ".k-station";
  const any = `:is(${row}, ${pane}, ${row} + [data-testid="session-children"])`;
  return [
    `${any} ${WORDS} { content: " ${words}"; font-family: var(--font-sans); font-stretch: normal; font-weight: 400; letter-spacing: 0; text-transform: none; white-space: pre; color: var(--muted); }`,
    `${any} .k-mark { opacity: 0.45; animation-play-state: paused; }`,
    `${any} .k-mark::before, ${any} .k-mark::after { animation-play-state: paused; }`,
    `${any} :is(.k-row-time[data-live], .k-station-clock) { color: var(--faint); }`,
  ].join("\n");
}
// A machine's id is letters and digits (src/fleet/fleet.ts); anything else names no rule.
const plain = (id: string) => /^[A-Za-z0-9]+$/.test(id);

// The marks, as a stylesheet of their own: mounted once, beside the page's band.
export function StaleMarks() {
  const away = useAway();
  const unheard = useReach((x) => x.unheard);
  const css = away !== null
    ? rules(null, `as of ${clock(away)}`)
    : Object.values(unheard).filter((m) => plain(m.id)).map((m) => rules({ row: `[data-session^="${m.id}--"]`, pane: `[data-station^="${m.id}--"]` }, `as of ${clock(m.since)}, offline`)).join("\n");
  if (!css) return null;
  return <style data-testid="stale-marks" data-stale={away !== null ? "page" : "machine"}>{css}</style>;
}

const line = (m: Unheard) => `${m.name} is offline since ${clock(m.since)}`;

// Above the list: each machine that is out of reach, and for a moment each that is back.
export function ReachLine({ open }: { open: boolean }) {
  const unheard = useReach((x) => x.unheard);
  const back = useReach((x) => x.back);
  // A word that is back leaves by itself; the page draws again when it does (lib/reach.ts).
  const out = Object.values(unheard).sort((a, b) => a.since - b.since);
  const backs = Object.values(back).filter((b) => Date.now() - b.at < BACK_MS + 1_000);
  if (!out.length && !backs.length) return null;
  if (!open) {
    if (!out.length) return null;
    return (
      <button type="button" data-testid="reach" data-reach="offline" aria-label={`${out.map(line).join(". ")}. Show the list`} title={out.map(line).join("\n")} onClick={() => toggleList(true)}
        className="mx-auto mt-1.5 flex h-ctl-sm w-[3.125rem] shrink-0 items-center justify-center gap-1 rounded-xs bg-sunken text-micro font-semibold text-muted hover:text-fg">
        <ServerOff className="size-3.5" /><span className="tabular-nums">{out.length}</span>
      </button>
    );
  }
  return (
    <section data-testid="reach" role="status" aria-label="Machines out of reach" className="mx-2.5 mb-2 flex shrink-0 flex-col gap-0.5">
      {out.map((m) => (
        <p key={m.id} data-testid="reach-item" data-machine={m.id} data-reach="offline" title={m.reason ? `${line(m)}: ${m.reason}. Its sessions show as they were then.` : `${line(m)}. Its sessions show as they were then.`}
          className="flex min-w-0 items-center gap-1.5 rounded-xs bg-sunken px-2 py-1 text-micro text-muted">
          <ServerOff className="size-3.5 shrink-0 text-faint" />
          <span className="min-w-0 truncate"><b className="font-semibold text-fg">{m.name}</b> offline since {clock(m.since)}</span>
        </p>
      ))}
      {backs.map((b) => (
        <p key={b.id} data-testid="reach-item" data-machine={b.id} data-reach="back" className="flex min-w-0 items-center gap-1.5 rounded-xs px-2 py-1 text-micro text-muted animate-in">
          <Server className="size-3.5 shrink-0 text-ok" />
          <span className="min-w-0 truncate"><b className="font-semibold text-fg">{b.name}</b> is back</span>
        </p>
      ))}
    </section>
  );
}
