import { copyOrSay } from "../../lib/copy.ts";
import { Dialog } from "@base-ui/react/dialog";
import { Check, CircleAlert, CircleCheck, CircleDashed, CircleSlash, Copy, ExternalLink, KeyRound, ListChecks, Pause, Play, Plus, Repeat, ShieldCheck, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { auto, autoState, inMs, openSession, useAuto, type LoopRecord, type RunRecord } from "../../lib/automation.ts";
import { api, reportError, useStore, failed, workspaces } from "../../lib/store.ts";
import { useSessionState } from "../../lib/watch.ts";
import { NEEDS } from "../../../../src/core/state-words.ts";
import { previewSchedule } from "../../../../src/automation/schedule.ts";
import { ModelPicker } from "../ModelPicker.tsx";
import { Mark } from "../Mark.tsx";
import { Select } from "../Select.tsx";
import { WorkspacePicker } from "../WorkspacePicker.tsx";
import { ago, clock, cn, fmtTokens } from "../../lib/utils.ts";
import { footSheet } from "../ui.tsx";
import { modelOf } from "../Mark.tsx";
import { Empty, IconButton } from "./bits.tsx";
import { QUEUED, STATE_WORD } from "../../../../src/core/state-words.ts";

// What a gated loop's row says of its checks: "12 checks, 2 ran".
const countChecks = (l: LoopRecord) => `${l.checks ?? 0} check${l.checks === 1 ? "" : "s"}, ${l.checks_ran ?? 0} ran`;

function RunIcon({ r }: { r: RunRecord }) {
  if (r.skip_reason) return <CircleSlash className="size-3.5 shrink-0 text-faint" />;
  if (!r.ended_ms) return <span className="grid size-3.5 place-items-center"><span className="size-1.5 rounded-full bg-st-work animate-pulse-dot" /></span>;
  if (r.outcome === "ok") return <CircleCheck className="size-3.5 shrink-0 text-ok" aria-label={STATE_WORD.done} />;
  if (r.outcome === "stopped") return <CircleSlash className="size-3.5 shrink-0 text-muted" aria-label={STATE_WORD.stop} />;
  if (r.outcome === "incomplete") return <CircleDashed className="size-3.5 shrink-0 text-warn" aria-label="Did not finish" />;
  return <CircleAlert className="size-3.5 shrink-0 text-danger" aria-label={STATE_WORD.fail} />;
}

// What a loop's run in progress waits on from the owner (an approval, a question), in words; "" when nothing.
// The run goes on only when they answer, so its row says so instead of "running".
function useWaitsOnOwner(loop: LoopRecord): string {
  const session = useStore((s) => s.sessions[loop.session_id]);
  const st = useSessionState(session);
  return loop.last_status === "running" && st.watch === "need" ? `waits for ${NEEDS[st.why ?? ""] ?? "an answer"} from you` : "";
}

const MODE_NAME: Record<string, string> = { ask: "Ask", "auto-edits": "Auto edits", auto: "Auto", "full-auto": "Full auto", "read-only": "Read only", plan: "Plan", reviewer: "Reviewer" };

const OUTCOME: Record<string, string> = { ok: "finished", failed: "failed", incomplete: "did not finish", stopped: "stopped" };

function CopyLine({ label, value, testid }: { label: string; value: string; testid: string }) {
  const [done, setDone] = useState(false);
  const line = useRef<HTMLDivElement>(null);
  return (
    <div>
      <p className="k-label">{label}</p>
      <div ref={line} className="mt-0.5 flex items-start gap-1.5">
        <code data-testid={testid} className="min-w-0 flex-1 break-all rounded-md bg-code px-2 py-1 font-mono text-micro">{value}</code>
        <IconButton title={`Copy ${label.toLowerCase()}`} onClick={() => copyOrSay(value, line.current?.querySelector("button")).then((ok) => { if (ok) setDone(true); })}>
          {done ? <Check className="size-3.5 text-ok" /> : <Copy className="size-3.5" />}
        </IconButton>
      </div>
    </div>
  );
}

// A webhook loop's URL and signing secret: in the answer that made them only,
// so they are shown here once and never again.
function ShownOnce({ keys }: { keys: { hook_key: string; hook_secret?: string } }) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-accent/40 bg-accent-soft px-3 py-2.5 text-caption" data-testid="webhook-keys">
      <p className="font-medium">Shown once. Copy them now: Keel keeps only a hash of the key and never shows the secret again.</p>
      <CopyLine label="Webhook URL" value={`${location.origin}/api/webhooks/${keys.hook_key}`} testid="webhook-url" />
      {keys.hook_secret && <CopyLine label="Signing secret" value={keys.hook_secret} testid="webhook-secret" />}
      {keys.hook_secret && (
        <p className="text-micro text-muted">
          Requests must carry Standard Webhooks headers (webhook-id, webhook-timestamp within five minutes, webhook-signature) or GitHub's X-Hub-Signature-256 with
          X-GitHub-Delivery. A delivery id runs once.
        </p>
      )}
    </div>
  );
}

function WebhookBox({ loop }: { loop: LoopRecord }) {
  const [keys, setKeys] = useState<{ hook_key: string; hook_secret?: string } | null>(null);
  useEffect(() => setKeys(null), [loop.id]);
  return (
    <div className="mt-3 flex flex-col gap-2">
      <div className="flex items-center gap-2 text-caption text-muted">
        {loop.signed ? <ShieldCheck className="size-3.5 text-ok" /> : <KeyRound className="size-3.5" />}
        <span data-testid="webhook-mode">{loop.signed ? "Signed requests only (HMAC-SHA256, five-minute window, each delivery once)" : loop.push ? "Anyone with the URL can push an event" : "Anyone with the URL can start a run"}{loop.push ? " · each request is an event in the session" : ""}</span>
        <button
          type="button"
          data-testid="rotate-key"
          onClick={() => auto.rotateKey(loop.id).then(setKeys).catch(reportError)}
          className="ml-auto rounded-md border border-line px-2 py-1 text-caption hover:bg-hover hover:text-fg"
        >
          {loop.signed ? "New key and secret" : "New key"}
        </button>
      </div>
      {keys && <ShownOnce keys={keys} />}
    </div>
  );
}

function History({ loop }: { loop: LoopRecord }) {
  const [runs, setRuns] = useState<RunRecord[] | null>(null);
  // The record is told again with every run and every skip: read the history again then. An answer
  // to an earlier read (a slow one a newer read overtook) is not shown.
  useEffect(() => {
    let stale = false;
    auto.runs(loop.id).then((r) => { if (!stale) setRuns(r.runs); }).catch((e) => {
      // A loop deleted while its history loads is not a failure.
      if (!stale && autoState().loops[loop.id]) reportError(e);
    });
    return () => void (stale = true);
  }, [loop]);
  const session = useStore((s) => s.sessions[loop.session_id]);
  const modelName = useStore((s) => s.models.find((m) => m.id === session?.model)?.name);
  const waits = useWaitsOnOwner(loop);
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="loop-history">
      <div className="border-b border-line px-5 py-4">
        <div className="flex items-center gap-2">
          <h3 className="min-w-0 flex-1 truncate text-base font-semibold">{loop.name}</h3>
          <button
            type="button"
            onClick={() => openSession(loop.session_id)}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-caption text-muted hover:bg-hover hover:text-fg"
          >
            {session?.title ? session.title.slice(0, 30) : "Session"} <ExternalLink className="size-3" />
          </button>
        </div>
        <p className="mt-1 text-caption text-muted">
          {loop.schedule_text}
          {/* Times in the loop's own zone: they hold wherever the daemon runs. */}
          {loop.kind === "cron" && loop.tz ? <span data-testid="loop-zone"> ({loop.tz})</span> : null}
          {loop.kind === "cron" && loop.next_runs?.length ? ` · next ${loop.next_runs.map((t) => clock(t, { weekday: true, zone: loop.tz ?? undefined })).join(", ")}` : ""}
          {loop.max_runs ? ` · at most ${loop.max_runs} runs` : ""}
          {loop.until_ms ? ` · until ${new Date(loop.until_ms).toLocaleDateString()}` : ""}
        </p>
        <p className="mt-0.5 flex min-w-0 gap-1.5 text-caption text-faint" data-testid="loop-where">
          {session && <span className="shrink-0 text-muted" data-testid="loop-model">{[modelName ?? modelOf(session.model), session.settings.effort].filter(Boolean).join(" · ")}</span>}
          {session && (loop.mode || session.workspace) && <span aria-hidden>·</span>}
          {loop.mode && <span className="shrink-0 text-muted" data-testid="loop-mode">{MODE_NAME[loop.mode] ?? loop.mode}</span>}
          {loop.mode && session?.workspace && <span aria-hidden>·</span>}
          {session?.workspace && <span className="truncate font-mono text-micro leading-[inherit]" title={session.workspace}>{session.workspace}</span>}
        </p>
        <p className="mt-2 line-clamp-3 rounded-lg bg-code px-3 py-2 font-mono text-caption text-muted whitespace-pre-wrap">{loop.prompt}</p>
        {loop.gate && (
          <div className="mt-2 flex flex-col gap-1" data-testid="loop-gate">
            <p className="k-label">Gate</p>
            <code className="line-clamp-2 break-all rounded-lg bg-code px-3 py-2 font-mono text-caption text-muted">{loop.gate}</code>
            <p className="text-caption text-faint" data-testid="loop-gate-count">
              {countChecks(loop)}{loop.last_check_ms ? ` · last ${ago(loop.last_check_ms)}: ${loop.last_check ?? ""}` : ""}
            </p>
          </div>
        )}
        {loop.kind === "webhook" && <WebhookBox loop={loop} />}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {runs?.length === 0 && <Empty>No runs yet.</Empty>}
        {runs?.map((r) => {
          const waiting = !!waits && !r.skip_reason && !!r.started_ms && !r.ended_ms;
          return (
          <div key={r.id} className="flex items-start gap-2.5 rounded-lg px-3 py-2 text-ui hover:bg-hover" data-testid="loop-run" data-waits={waiting || undefined}>
            <span className="mt-0.5">{waiting ? <span className="grid size-3.5 place-items-center"><Mark w="need" /></span> : <RunIcon r={r} />}</span>
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <span>{clock(r.started_ms ?? r.due_ms, { date: true, seconds: true })}</span>
                <span className={cn("text-caption", waiting ? "font-medium text-accent" : "text-faint")}>
                  {waiting ? waits : r.skip_reason ? "not run" : r.ended_ms && r.started_ms ? `${r.outcome ? `${OUTCOME[r.outcome]} · ` : ""}${((r.ended_ms - r.started_ms) / 1000).toFixed(1)}s` : r.started_ms ? "running" : `${QUEUED.toLowerCase()} behind the session's turn`}
                </span>
                {r.usage && r.usage.calls > 0 && (
                  <span className="ml-auto text-micro text-faint tabular-nums">
                    {fmtTokens(r.usage.input + r.usage.cache_read + r.usage.cache_write)} in · {fmtTokens(r.usage.output)} out
                  </span>
                )}
              </div>
              {(r.skip_reason || r.note || (r.outcome && r.outcome !== "ok" && r.detail) || r.delay_reason) && (
                <p className={cn("text-caption", r.outcome === "failed" ? "text-danger" : r.outcome === "incomplete" ? "text-warn" : "text-faint")} data-testid="loop-run-detail">
                  {[r.skip_reason, r.outcome && r.outcome !== "ok" ? r.detail : "", r.note, r.next_delay_seconds ? `next in ${Math.round(r.next_delay_seconds / 60)}m${r.delay_reason ? `: ${r.delay_reason}` : ""}` : ""].filter(Boolean).join(" · ")}
                </p>
              )}
            </div>
          </div>
          );
        })}
      </div>
    </div>
  );
}

// What the schedule typed means, read as it is typed: its words and its next three runs (a time
// that is not today with its day), or why it is not a schedule.
function When({ preview, zone }: { preview: ReturnType<typeof previewSchedule>; zone: string }) {
  const today = new Date().toDateString();
  const at = (t: number, cal: boolean) => clock(t, { weekday: cal || new Date(t).toDateString() !== today });
  const words = "error" in preview
    ? preview.error
    : preview.kind === "cron"
      ? `${preview.text} (${zone})${preview.next.length ? ` · next ${preview.next.map((t) => at(t, true)).join(", ")}` : ""}`
      : preview.kind === "interval"
        ? `${preview.text} · next ${preview.next.map((t) => at(t, false)).join(", ")}`
        : preview.kind === "auto"
          ? "self-paced: after each run the model says when the next one comes"
          : "runs when its webhook is called; the URL is shown once, when it is made";
  return (
    <p id="new-loop-when" data-testid="new-loop-when" data-bad={"error" in preview ? "" : undefined} aria-live="polite" className={cn("px-1 text-caption tabular-nums", "error" in preview ? "text-warn" : "text-muted")}>
      {words}
    </p>
  );
}

function NewLoop({ onDone }: { onDone: (id: string) => void }) {
  const [schedule, setSchedule] = useState("1h");
  const [prompt, setPrompt] = useState("");
  const [name, setName] = useState("");
  const [err, setErr] = useState("");
  const [signed, setSigned] = useState(true);
  const [push, setPush] = useState(false);
  const [gate, setGate] = useState("");
  const [keys, setKeys] = useState<{ hook_key: string; hook_secret?: string } | null>(null);
  // Where its runs work and what they may do without asking, said before it is made: a run
  // that asks waits for the owner, and the next runs are skipped until they answer.
  const [cwd, setCwd] = useState("");
  const [mode, setMode] = useState("");
  const [modes, setModes] = useState<{ id: string; name: string; summary?: string }[]>([]);
  useEffect(() => {
    workspaces().then((r) => setCwd((c) => c || (r.recent[0]?.path ?? r.default))).catch(reportError);
    api<{ default_mode: string; modes: { id: string; name: string; summary?: string }[] }>("/api/permissions/settings")
      .then((r) => { setModes(r.modes); setMode((m) => m || r.default_mode); })
      .catch(reportError);
  }, []);
  const asks = mode === "ask" || mode === "auto-edits" || mode === "plan";
  const isHook = schedule.trim().toLowerCase() === "webhook";
  // The model and effort its runs use: the default model until another is picked, and the model's
  // own effort unless one it lists is picked.
  const def = useStore((s) => s.defaultModel);
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const runsOn = model || def;
  const efforts = useStore((s) => s.models.find((m) => m.id === runsOn)?.efforts) ?? [];
  if (effort && !efforts.includes(effort)) setEffort("");
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const preview = useMemo(() => previewSchedule(schedule, Date.now(), 3, zone), [schedule, zone]);
  const field = "k-field h-auto w-full py-2";
  // A gate is for a loop on an interval or a calendar schedule.
  const gateable = !("error" in preview) && (preview.kind === "interval" || preview.kind === "cron");
  return (
    <form
      className="flex flex-col gap-3 p-5"
      data-testid="new-loop"
      onSubmit={async (e) => {
        e.preventDefault();
        // The folder picker's path box is a form of its own, in a portal: its Enter is not this form's.
        if (e.target !== e.currentTarget) return;
        setErr("");
        try {
          // The zone the preview read the schedule in: the made loop's times are the ones shown.
          const l = await auto.createLoop({ name: name || undefined, schedule, prompt, ...(cwd ? { cwd } : {}), ...(mode ? { mode } : {}), ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(zone ? { tz: zone } : {}), ...(gateable && gate.trim() ? { gate: gate.trim() } : {}), ...(isHook ? { signed, ...(push ? { push } : {}) } : {}) });
          if (l.hook_key) setKeys({ hook_key: l.hook_key, hook_secret: l.hook_secret });
          else onDone(l.id);
        } catch (x) {
          setErr(failed(x, { at: "LoopsPanel" }));
        }
      }}
    >
      <h3 className="text-base font-semibold">New loop</h3>
      <p className="-mt-2 text-caption text-muted">Runs in a session of its own. Use /loop in a session's composer to loop there.</p>
      <div className="flex flex-wrap items-center gap-2" data-testid="new-loop-where">
        <WorkspacePicker value={cwd} onChange={setCwd} />
        <Select data-testid="new-loop-mode" aria-label="Permission mode" value={mode} onChange={(e) => setMode(e.target.value)} className="w-40 text-caption">
          {modes.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </Select>
        <ModelPicker value={runsOn} onChange={(id) => setModel(id)} placeholder="Default model" />
        {efforts.length > 0 && (
          <Select data-testid="new-loop-effort" aria-label="Effort" value={effort} onChange={(e) => setEffort(e.target.value)} className="w-36 text-caption">
            <option value="">Model's effort</option>
            {efforts.map((x) => <option key={x} value={x}>{x}</option>)}
          </Select>
        )}
      </div>
      {asks && <p className="-mt-1 text-caption text-faint" data-testid="new-loop-asks">In this mode a run that edits or runs a command waits for your approval, and the runs due meanwhile are skipped.</p>}
      <input className={field} placeholder="Name (optional)" value={name} onChange={(e) => setName(e.target.value)} />
      <div className="flex flex-col gap-1">
        <input className={cn(field, "font-mono")} placeholder="5m, 2h, daily, weekdays 09:30, 0 9 * * 1-5, auto, webhook" value={schedule} onChange={(e) => setSchedule(e.target.value)} data-testid="new-loop-schedule" aria-describedby="new-loop-when" />
        <When preview={preview} zone={zone} />
      </div>
      <textarea className={cn(field, "min-h-28 resize-y")} placeholder="What to do each run" value={prompt} onChange={(e) => setPrompt(e.target.value)} data-testid="new-loop-prompt" />
      {gateable && (
        <div className="flex flex-col gap-1">
          <label htmlFor="new-loop-gate" className="k-label">Gate (optional)</label>
          <textarea id="new-loop-gate" className={cn(field, "min-h-16 resize-y font-mono")} placeholder="A command that runs first: the prompt runs only when it exits 0" value={gate} onChange={(e) => setGate(e.target.value)} data-testid="new-loop-gate" aria-describedby="new-loop-gate-note" />
          <p id="new-loop-gate-note" className="px-1 text-caption text-faint">
            It runs in the folder, inside the sandbox, at each time (30 s at most) and its output comes with the prompt. Exit 1 skips the run at no cost; any other end counts as a failed run.
          </p>
        </div>
      )}
      {isHook && (
        <label className="flex items-center gap-2 text-ui">
          <input type="checkbox" data-testid="new-loop-signed" checked={signed} onChange={(e) => setSigned(e.target.checked)} className="accent-[var(--accent)]" />
          Check signatures (HMAC, timestamp, replay window)
        </label>
      )}
      {isHook && (
        <label className="flex items-center gap-2 text-ui">
          <input type="checkbox" data-testid="new-loop-push" checked={push} onChange={(e) => setPush(e.target.checked)} className="accent-[var(--accent)]" />
          Push each request into the session as an event (read at its next step), not a run after its turn
        </label>
      )}
      {err && <p className="text-caption text-danger">{err}</p>}
      {keys && <ShownOnce keys={keys} />}
      <button type="submit" disabled={"error" in preview || !!keys} className="self-start rounded-lg bg-accent px-3.5 py-1.5 text-ui font-medium text-accent-fg hover:opacity-90 disabled:opacity-40">
        Create loop
      </button>
    </form>
  );
}

function LoopItem({ l, picked, onPick }: { l: LoopRecord; picked: boolean; onPick: () => void }) {
  const waits = useWaitsOnOwner(l);
  const act = (p: Promise<unknown>) => p.catch(reportError);
  return (
    <div
      role="button"
      tabIndex={0}
      data-testid="loop-item"
      data-waits={waits ? "" : undefined}
      onClick={onPick}
      onKeyDown={(e) => e.key === "Enter" && onPick()}
      className={cn("group flex cursor-default items-center gap-2 rounded-lg px-2.5 py-2 outline-none hover:bg-hover", picked && "k-picked")}
    >
      {waits ? <span className="grid size-2 shrink-0 place-items-center"><Mark w="need" /></span> : <span className={cn("size-2 shrink-0 rounded-full", l.last_status === "running" ? "bg-st-work animate-pulse-dot" : l.enabled ? (l.last_status === "failed" ? "bg-danger" : "bg-ok") : "bg-line-strong")} />}
      <div className="min-w-0 flex-1">
        <div className={cn("truncate text-ui", !l.enabled && "text-muted")}>{l.name}</div>
        <div className="truncate text-micro text-faint" data-testid="loop-item-state">
          {waits ? <span className="font-medium text-accent">{waits}</span> : <>{l.schedule_text} · {l.enabled ? (l.next_ms ? inMs(l.next_ms) : l.kind === "webhook" ? "on call" : "running") : (l.disabled_reason ?? "paused")}</>}
          {l.gate ? ` · ${countChecks(l)}` : ""}
          {l.last_ms ? ` · ran ${ago(l.last_ms)}` : ""}
        </div>
      </div>
      <span className="hidden items-center group-hover:flex">
        {/* A run that waits for the owner goes on when they answer: another run would only be refused. */}
        {!waits && <IconButton title="Run now" onClick={() => act(auto.runLoop(l.id))}><Play className="size-3.5" /></IconButton>}
        {/* The gate command now, and the prompt when it says so: the run by hand above never asks the gate. */}
        {l.gate && l.enabled && <IconButton title="Check now" onClick={() => act(auto.checkLoop(l.id))}><ListChecks className="size-3.5" /></IconButton>}
        <IconButton title={l.enabled ? "Turn off" : "Turn on"} onClick={() => act(auto.patchLoop(l.id, { enabled: !l.enabled }))}>
          {l.enabled ? <Pause className="size-3.5" /> : <Repeat className="size-3.5" />}
        </IconButton>
        <IconButton title="Delete" danger onClick={() => act(auto.deleteLoop(l.id))}><Trash2 className="size-3.5" /></IconButton>
      </span>
    </div>
  );
}

export function LoopsPanel({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const all = useAuto((s) => s.loops);
  const loops = useMemo(() => Object.values(all).sort((a, b) => Number(b.enabled) - Number(a.enabled) || b.created - a.created), [all]);
  const [sel, setSel] = useState<string | "new" | null>(null);
  const current = sel === "new" ? null : loops.find((l) => l.id === sel) ?? loops[0];
  const act = (p: Promise<unknown>) => p.catch(reportError);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-overlay transition-opacity data-starting-style:opacity-0 data-ending-style:opacity-0" />
        <Dialog.Popup
          data-testid="loops-panel"
          data-float
          className={footSheet(true)}
        >
          <div className="k-surface-head">
            <Repeat className="k-surface-icon" />
            <Dialog.Title className="k-surface-title">Loops</Dialog.Title>
            <span className="k-surface-note">prompts that run again by themselves; no tokens between runs</span>
            <Dialog.Close className="k-surface-close" aria-label="Close"><X /></Dialog.Close>
          </div>
          <div className="flex min-h-0 flex-1">
            <div className="flex w-80 shrink-0 flex-col border-r border-line">
              <div className="min-h-0 flex-1 overflow-y-auto p-2" data-testid="loop-list">
                {loops.length === 0 && <Empty>No loops yet.</Empty>}
                {loops.map((l) => <LoopItem key={l.id} l={l} picked={current?.id === l.id} onPick={() => setSel(l.id)} />)}
              </div>
              <div className="border-t border-line p-2">
                <button
                  type="button"
                  data-testid="new-loop-button"
                  onClick={() => setSel("new")}
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-ui font-medium hover:bg-hover"
                >
                  <Plus className="size-4" /> New loop
                </button>
              </div>
            </div>
            <div className="flex min-w-0 flex-1 flex-col">
              {/* Keyed by the loop: the history of the loop picked before is never shown under this one. */}
              {sel === "new" || !current ? <NewLoop onDone={setSel} /> : <History key={current.id} loop={current} />}
            </div>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
