// A conversation another harness still runs on a machine reached over ssh,
// resumed here: whether the original works on something, and the owner's
// choice. Wait until it is idle (with a deadline that is shown), or resume now
// (shown what is in flight, its background jobs first, kept running or ended
// with it). The same state and choices sit on the conversation's row of the
// import list.
import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import { CircleStop, Hourglass, Play } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { api, failed, onFeature } from "../lib/store.ts";
import { navigate } from "../lib/ui.ts";
import { ago, cn, fmtWait } from "../lib/utils.ts";
import { Select } from "./Select.tsx";

// `jobs`: how many of what is in flight are background jobs (a wait is for the rest).
export type Original = { state: "active" | "idle"; why: string; brief?: string; in_flight: number; jobs?: number };
export type Wait = {
  machine_id: string; harness: string; id: string; jobs: "keep" | "end";
  state: "waiting" | "resumed" | "expired" | "failed" | "cancelled";
  started_ms: number; deadline_ms: number; ended_ms?: number;
  last?: { state: string; why: string; checked_ms: number };
  session_id?: string; error?: string;
};
type InFlight = { kind: "job" | "tool" | "subagent" | "turn" | "prompt"; label: string; command?: string; pid?: number; pgid?: number; since_ms?: number };
type Seen = {
  state: "ended" | "idle" | "active"; why: string; brief?: string; in_flight: InFlight[];
  helpers: { pid: number; command: string; since_ms: number }[];
  process?: { pid: number; started_ms: number; status?: string }; checked_ms: number; revision?: string; wait?: Wait;
};
export type Intent = "wait" | "now" | null;
type Target = { machine: string; harness: string; id: string };

// What is known of each conversation's original and of a wait for it: from
// the list, from the pane's own look every two seconds, and from the daemon's
// frames while a wait runs.
type Known = { original?: Original; wait?: Wait };
const known = new Map<string, Known>();
const subs = new Set<() => void>();
const keyOf = (t: Target) => `${t.machine}:${t.harness}:${t.id}`;
const put = (k: string, p: Known) => { known.set(k, { ...known.get(k), ...p }); subs.forEach((f) => f()); };
const useKnown = (t: Target): Known => useSyncExternalStore((f) => (subs.add(f), () => void subs.delete(f)), () => known.get(keyOf(t)) ?? NONE);
const NONE: Known = {};
onFeature({ frame: (f) => { if (f.name === "fleet_resume") { const w = (f.data as { wait: Wait }).wait; put(`${w.machine_id}:${w.harness}:${w.id}`, { wait: w }); } } });

// The rows of a listing say what their originals do.
export function noteRows(machine: string, rows: { harness: string; id: string; original?: Original; wait?: Wait }[]) {
  for (const r of rows) known.set(`${machine}:${r.harness}:${r.id}`, { original: r.original, wait: r.wait });
  subs.forEach((f) => f());
}

const clock = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const KIND: Record<InFlight["kind"], string> = { job: "job", tool: "call", subagent: "subagent", turn: "reply", prompt: "prompt" };
const DEADLINES = [{ ms: 5 * 60_000, label: "5 minutes" }, { ms: 15 * 60_000, label: "15 minutes" }, { ms: 60 * 60_000, label: "1 hour" }];

function StateDot({ state }: { state: string }) {
  return <span className={cn("size-1.5 shrink-0 rounded-full", state === "active" ? "animate-pulse bg-st-work" : state === "idle" ? "bg-ok" : "bg-line-strong")} />;
}

// Ticks once a second while something counts down.
function useNow(on: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

const cancelWait = (t: Target) => api(`/api/fleet/machines/${t.machine}/transcripts/resume?harness=${t.harness}&id=${encodeURIComponent(t.id)}`, { method: "DELETE" });

// The second line of a conversation's row: what its original does, and the choices.
export function OriginalStrip({ target, tool, onPick, onOpen }: { target: Target; tool: string; onPick: (intent: Intent) => void; onOpen: (sessionId: string) => void }) {
  const k = useKnown(target);
  const w = k.wait;
  const now = useNow(w?.state === "waiting");
  if (!k.original && !w) return null;
  const pick = "h-6 shrink-0 rounded-md px-2 text-micro font-medium text-accent hover:bg-accent-soft";
  return (
    <div data-testid="original-strip" data-state={w?.state === "waiting" ? "waiting" : w?.state === "resumed" ? "resumed" : k.original?.state ?? "ended"} className="flex items-center gap-2 px-3 pb-2 text-micro text-muted">
      {w?.state === "waiting" ? (
        <>
          <Hourglass className="size-3 shrink-0 text-st-work" />
          <span className="min-w-0 flex-1 truncate">Waiting until it is idle · gives up at {clock(w.deadline_ms)} ({fmtWait(w.deadline_ms - now)})</span>
          <button type="button" data-testid="strip-cancel" onClick={() => void cancelWait(target)} className={pick}>Cancel</button>
        </>
      ) : w?.state === "resumed" && w.session_id ? (
        <>
          <StateDot state="idle" />
          <span className="min-w-0 flex-1 truncate">Resumed here once it was idle</span>
          <button type="button" data-testid="strip-open" onClick={() => onOpen(w.session_id!)} className={pick}>Open</button>
        </>
      ) : k.original ? (
        <>
          <StateDot state={k.original.state} />
          <span className="min-w-0 flex-1 truncate" data-testid="strip-state" title={k.original.state === "active" ? `${tool} is still working on this: ${k.original.why}` : `${tool} has this open, idle`}>
            {k.original.state === "active" ? `Active · ${k.original.brief ?? k.original.why}` : `Open in ${tool}, idle`}
            {w?.state === "expired" && " · the wait gave up"}
          </span>
          {k.original.state === "active" ? (
            <>
              {k.original.in_flight > (k.original.jobs ?? 0) && <button type="button" data-testid="strip-wait" onClick={() => onPick("wait")} className={pick}>Wait until idle</button>}
              <button type="button" data-testid="strip-now" onClick={() => onPick("now")} className={pick}>Resume now</button>
            </>
          ) : (
            <button type="button" data-testid="strip-resume" onClick={() => onPick(null)} className={pick}>Resume here</button>
          )}
        </>
      ) : null}
    </div>
  );
}

// The resume sheet: the top of a conversation's preview while its harness runs.
// Also above the composer of a copy whose original still runs there (`every`: how often it looks).
export function ResumeCard({ target, tool, machineName, every = 2000, onDone = () => {}, ...ctl }: { target: Target; tool: string; machineName: string; every?: number; intent?: Intent; onIntent?: (i: Intent) => void; onDone?: () => void }) {
  const [own, setOwn] = useState<Intent>(null);
  const intent = ctl.onIntent ? ctl.intent ?? null : own;
  const onIntent = ctl.onIntent ?? setOwn;
  const [seen, setSeen] = useState<Seen | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [jobs, setJobs] = useState<"keep" | "end">("keep");
  const [waitMs, setWaitMs] = useState(DEADLINES[1]!.ms);
  const wait = useKnown(target).wait;
  const waiting = wait?.state === "waiting";
  const now = useNow(waiting || intent === "wait");
  const k = keyOf(target);

  // Looked at again every two seconds while it runs: what is in flight changes.
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    setSeen(null);
    setErr("");
    const look = () => api<Seen>(`/api/fleet/machines/${target.machine}/transcripts/activity?harness=${target.harness}&id=${encodeURIComponent(target.id)}`).then((r) => {
      if (!live) return;
      setSeen(r);
      put(k, { original: r.state === "ended" ? undefined : { state: r.state, why: r.why, brief: r.brief, in_flight: r.in_flight.length, jobs: r.in_flight.filter((i) => i.kind === "job").length }, wait: r.wait });
      if (r.state !== "ended") timer = setTimeout(look, every);
    }, (e) => {
      // In the sheet a machine that did not answer is asked again; a session's page asks once.
      if (live && ctl.onIntent) { setErr(e.message); timer = setTimeout(look, 5000); }
    });
    look();
    return () => { live = false; clearTimeout(timer); };
  }, [k]);

  // A wait that ends in a resume while this is on screen opens the session it made.
  const was = useRef(wait?.state);
  useEffect(() => {
    if (was.current === "waiting" && wait?.state === "resumed" && wait.session_id) { onDone(); navigate({ name: "session", id: wait.session_id }); }
    was.current = wait?.state;
  }, [wait?.state, wait?.session_id]);

  if (!seen || seen.state === "ended") return null;
  const go = async (when: "now" | "idle") => {
    setBusy(true);
    setErr("");
    try {
      const r = await api<{ action: string; session?: { id: string } }>(`/api/fleet/machines/${target.machine}/transcripts/resume`, {
        method: "POST", body: JSON.stringify({ harness: target.harness, id: target.id, revision: seen.revision, when, jobs, wait_ms: when === "idle" ? waitMs : undefined }),
      });
      onIntent(null);
      if (r.action === "taken_over" && r.session) { setSeen(null); onDone(); navigate({ name: "session", id: r.session.id }); }
    } catch (e) {
      setErr(failed(e, { at: "ResumeFrom" }));
    } finally {
      setBusy(false);
    }
  };
  const active = seen.state === "active";
  const jobList = seen.in_flight.filter((i) => i.kind === "job");
  const waitable = seen.in_flight.length > jobList.length; // a turn, a call or a subagent: a job alone is not waited for
  const quiet = "h-8 rounded-lg px-3 text-ui text-muted hover:bg-hover hover:text-fg disabled:opacity-40";
  const plain = "inline-flex h-8 items-center gap-1.5 rounded-lg border border-line-strong px-3 text-ui font-medium hover:bg-hover disabled:opacity-40";
  const primary = "inline-flex h-8 items-center gap-1.5 rounded-lg bg-accent px-3 text-ui font-medium text-accent-fg hover:opacity-90 disabled:opacity-40";

  return (
    <section data-testid="resume-card" data-state={waiting ? "waiting" : seen.state} className={cn("rounded-xl border border-line bg-raised text-left", ctl.onIntent ? "mb-5" : "mb-2")}>
      <div className="flex items-start gap-2.5 px-4 pt-3.5 pb-3">
        <span className="mt-1.5"><StateDot state={seen.state} /></span>
        <div className="min-w-0 flex-1">
          <p className="text-ui font-medium" data-testid="resume-state">
            {active ? `${tool} is still working on this on ${machineName}` : `${tool} has this open on ${machineName}, idle`}
          </p>
          <p className="mt-0.5 text-caption text-muted">
            {active ? (waitable ? `${seen.why}. Resuming ends it there: wait until it is idle, or resume now and the copy redoes what was in flight.` : `${seen.why}. Its turn is over. Resuming ends it there, and you choose what becomes of ${jobList.length === 1 ? "the job" : "the jobs"}.`) : "Resuming ends it there the way a closed terminal does, and goes on here from what it wrote last."}
          </p>
        </div>
      </div>

      {seen.in_flight.length > 0 && (
        <ul className="border-t border-line" data-testid="in-flight">
          {seen.in_flight.map((i, n) => (
            <li key={n} data-testid="in-flight-item" data-kind={i.kind} className="flex items-baseline gap-2.5 border-b border-line/60 px-4 py-2 last:border-b-0">
              <span className={cn("w-16 shrink-0 text-micro font-medium uppercase tracking-wide", i.kind === "job" ? "text-brass" : "text-faint")}>{KIND[i.kind]}</span>
              <span className="min-w-0 flex-1">
                <span className="block break-words text-caption text-fg">{i.label}</span>
                {i.kind === "job" && i.command && <span className="block truncate font-mono text-micro text-faint">{i.command}</span>}
              </span>
              <span className="shrink-0 text-micro tabular-nums text-faint">{i.pid ? `pid ${i.pid}` : ""}{i.pid && i.since_ms ? " · " : ""}{i.since_ms ? ago(i.since_ms) : ""}</span>
            </li>
          ))}
        </ul>
      )}
      {seen.helpers.length > 0 && (
        <p className="border-t border-line px-4 py-2 text-micro text-faint" data-testid="resume-helpers">
          Also under it, not started by a call: {seen.helpers.length} {seen.helpers.length === 1 ? "process" : "processes"} (a hook or a helper of {tool}). {seen.helpers.length === 1 ? "It is" : "They are"} left to {tool}.
        </p>
      )}

      <div className="border-t border-line px-4 py-3">
        {jobList.length > 0 && ((!waiting && intent === "wait") || intent === "now") && (
          <div className="mb-3">
            <p className="text-caption font-medium">{jobList.length === 1 ? "Its background job" : `Its ${jobList.length} background jobs`}</p>
            <RadioGroup value={jobs} onValueChange={(v) => setJobs(v as "keep" | "end")} className="mt-1.5 flex flex-col gap-1.5">
              {([["keep", "Keep running", "Keel leaves jobs alone. The original may stop them on exit; the copy reports which survived."], ["end", "End with it", "Ended after the original, and the copy is told to start what is still needed."]] as const).map(([v, name, what]) => (
                <label key={v} className="flex cursor-pointer items-start gap-2.5">
                  <Radio.Root value={v} data-testid={`jobs-${v}`} className="mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border border-line-strong outline-none focus-visible:ring-2 focus-visible:ring-accent/40 data-checked:border-accent">
                    <Radio.Indicator className="size-2 rounded-full bg-accent" />
                  </Radio.Root>
                  <span className="min-w-0"><span className="block text-ui">{name}</span><span className="block text-caption text-muted">{what}</span></span>
                </label>
              ))}
            </RadioGroup>
          </div>
        )}
        {waiting ? (
          <div className="flex items-center gap-3" data-testid="resume-waiting">
            <Hourglass className="size-4 shrink-0 text-st-work" />
            <div className="min-w-0 flex-1">
              <p className="text-ui">Waiting until it is idle</p>
              <p className="text-caption text-muted" data-testid="resume-deadline">Gives up at {clock(wait!.deadline_ms)}, in {fmtWait(wait!.deadline_ms - now)}. Then it is left running and you choose again.{jobList.length > 0 && (wait!.jobs === "end" ? " Its background jobs end only if Keel resumes the session." : " Its background jobs are left running.")}</p>
            </div>
            <button type="button" data-testid="resume-cancel" onClick={() => void cancelWait(target)} className={quiet}>Cancel</button>
            <button type="button" data-testid="resume-now-instead" onClick={() => onIntent("now")} className={plain}>Resume now</button>
          </div>
        ) : !active ? (
          <div className="flex items-center justify-end gap-2">
            <button type="button" data-testid="resume-here" disabled={busy} onClick={() => void go("now")} className={primary}><Play className="size-3.5" /> Resume here</button>
          </div>
        ) : intent === "now" ? null : intent === "wait" ? (
          <div className="flex flex-wrap items-center gap-2" data-testid="resume-wait-form">
            <span className="text-ui">Wait for at most</span>
            <Select data-testid="resume-wait-for" value={String(waitMs)} onChange={(e) => setWaitMs(Number(e.target.value))} className="h-8 rounded-md border border-line bg-bg px-2 text-ui text-fg outline-none focus-visible:border-accent">
              {DEADLINES.map((d) => <option key={d.ms} value={d.ms}>{d.label}</option>)}
            </Select>
            <span className="min-w-0 flex-1 text-caption text-muted" data-testid="resume-until">until {clock(now + waitMs)}</span>
            <button type="button" onClick={() => onIntent(null)} className={quiet}>Back</button>
            <button type="button" data-testid="resume-wait-go" disabled={busy} onClick={() => void go("idle")} className={primary}><Hourglass className="size-3.5" /> Wait, then resume</button>
          </div>
        ) : (
          <div className="flex items-center justify-end gap-2" data-testid="resume-choices">
            {wait?.state === "expired" && <span className="min-w-0 flex-1 text-caption text-warn" data-testid="resume-expired">The wait gave up at {clock(wait.deadline_ms)}: Keel could not confirm it was idle.</span>}
            {waitable && <button type="button" data-testid="resume-wait" onClick={() => onIntent("wait")} className={plain}><Hourglass className="size-3.5" /> Wait until idle</button>}
            <button type="button" data-testid="resume-now" onClick={() => onIntent("now")} className={plain}><CircleStop className="size-3.5" /> Resume now</button>
          </div>
        )}
        {intent === "now" && (active || waiting) && (
          <div data-testid="resume-now-form" className={cn(waiting && "mt-3 border-t border-line pt-3")}>
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 text-caption text-muted">
                {seen.in_flight.some((i) => i.kind !== "job") ? "The calls above are interrupted. The copy gets this list in a note, so it can redo them." : "The copy gets this list in a note."}
              </span>
              <button type="button" onClick={() => onIntent(null)} className={quiet}>Back</button>
              <button type="button" data-testid="resume-now-go" disabled={busy} onClick={() => void go("now")} className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-danger px-3 text-ui font-medium text-accent-fg hover:opacity-90 disabled:opacity-40"><CircleStop className="size-3.5" /> End it and resume here</button>
            </div>
          </div>
        )}
        {err && <p className="mt-2 rounded-md bg-danger-soft px-3 py-2 text-caption text-danger" data-testid="resume-error">{err}</p>}
      </div>
    </section>
  );
}
