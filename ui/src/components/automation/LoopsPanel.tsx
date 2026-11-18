import { Dialog } from "@base-ui/react/dialog";
import { Check, CircleAlert, CircleCheck, CircleSlash, Copy, ExternalLink, KeyRound, Pause, Play, Plus, Repeat, ShieldCheck, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { auto, autoState, inMs, openSession, useAuto, type LoopRecord, type RunRecord } from "../../lib/automation.ts";
import { reportError, useStore } from "../../lib/store.ts";
import { ago, cn, fmtTokens } from "../../lib/utils.ts";
import { Empty, IconButton } from "./bits.tsx";

function RunIcon({ r }: { r: RunRecord }) {
  if (r.skip_reason) return <CircleSlash className="size-3.5 shrink-0 text-faint" />;
  if (!r.ended_ms) return <span className="grid size-3.5 place-items-center"><span className="size-1.5 rounded-full bg-brass animate-pulse-dot" /></span>;
  return r.ok ? <CircleCheck className="size-3.5 shrink-0 text-ok" /> : <CircleAlert className="size-3.5 shrink-0 text-danger" />;
}

function CopyLine({ label, value, testid }: { label: string; value: string; testid: string }) {
  const [done, setDone] = useState(false);
  return (
    <div>
      <p className="text-micro font-medium text-muted">{label}</p>
      <div className="mt-0.5 flex items-start gap-1.5">
        <code data-testid={testid} className="min-w-0 flex-1 break-all rounded-md bg-code px-2 py-1 font-mono text-micro">{value}</code>
        <IconButton title={`Copy ${label.toLowerCase()}`} onClick={() => navigator.clipboard?.writeText(value).then(() => setDone(true)).catch(reportError)}>
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
        <span data-testid="webhook-mode">{loop.signed ? "Signed requests only (HMAC-SHA256, five-minute window, each delivery once)" : "Anyone with the URL can start a run"}</span>
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
  // The record changes with every run: read the history again then.
  useEffect(() => {
    auto.runs(loop.id).then((r) => setRuns(r.runs)).catch((e) => {
      // A loop deleted while its history loads is not a failure.
      if (autoState().loops[loop.id]) reportError(e);
    });
  }, [loop.id, loop.runs, loop.last_status, loop.next_ms]);
  const session = useStore((s) => s.sessions[loop.session_id]);
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
          {loop.kind === "cron" && loop.next_runs?.length ? ` · next ${loop.next_runs.map((t) => new Date(t).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })).join(", ")}` : ""}
          {loop.max_runs ? ` · at most ${loop.max_runs} runs` : ""}
          {loop.until_ms ? ` · until ${new Date(loop.until_ms).toLocaleDateString()}` : ""}
        </p>
        <p className="mt-2 line-clamp-3 rounded-lg bg-code px-3 py-2 font-mono text-caption text-muted whitespace-pre-wrap">{loop.prompt}</p>
        {loop.kind === "webhook" && <WebhookBox loop={loop} />}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {runs?.length === 0 && <Empty>No runs yet.</Empty>}
        {runs?.map((r) => (
          <div key={r.id} className="flex items-start gap-2.5 rounded-lg px-3 py-2 text-ui hover:bg-hover" data-testid="loop-run">
            <span className="mt-0.5"><RunIcon r={r} /></span>
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <span>{new Date(r.started_ms ?? r.due_ms).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
                <span className="text-caption text-faint">
                  {r.skip_reason ? "not run" : r.ended_ms && r.started_ms ? `${((r.ended_ms - r.started_ms) / 1000).toFixed(1)}s` : r.started_ms ? "running" : "waiting for the session"}
                </span>
                {r.usage && r.usage.calls > 0 && (
                  <span className="ml-auto text-micro text-faint tabular-nums">
                    {fmtTokens(r.usage.input + r.usage.cache_read + r.usage.cache_write)} in · {fmtTokens(r.usage.output)} out
                  </span>
                )}
              </div>
              {(r.skip_reason || r.note || (r.ok === false && r.detail) || r.delay_reason) && (
                <p className={cn("text-caption", r.ok === false ? "text-danger" : "text-faint")}>
                  {[r.skip_reason, r.ok === false ? r.detail : "", r.note, r.next_delay_seconds ? `next in ${Math.round(r.next_delay_seconds / 60)}m${r.delay_reason ? `: ${r.delay_reason}` : ""}` : ""].filter(Boolean).join(" · ")}
                </p>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function NewLoop({ onDone }: { onDone: (id: string) => void }) {
  const [schedule, setSchedule] = useState("1h");
  const [prompt, setPrompt] = useState("");
  const [name, setName] = useState("");
  const [err, setErr] = useState("");
  const [signed, setSigned] = useState(true);
  const [keys, setKeys] = useState<{ hook_key: string; hook_secret?: string } | null>(null);
  const isHook = schedule.trim().toLowerCase() === "webhook";
  const field = "w-full rounded-lg border border-line bg-bg px-3 py-2 text-ui outline-none focus:border-line-strong placeholder:text-faint";
  return (
    <form
      className="flex flex-col gap-3 p-5"
      data-testid="new-loop"
      onSubmit={async (e) => {
        e.preventDefault();
        setErr("");
        try {
          const l = await auto.createLoop({ name: name || undefined, schedule, prompt, ...(isHook ? { signed } : {}) });
          if (l.hook_key) setKeys({ hook_key: l.hook_key, hook_secret: l.hook_secret });
          else onDone(l.id);
        } catch (x) {
          setErr((x as Error).message);
        }
      }}
    >
      <h3 className="text-base font-semibold">New loop</h3>
      <p className="-mt-2 text-caption text-muted">Runs in a session of its own on the default model. Use /loop in a session's composer to loop there.</p>
      <input className={field} placeholder="Name (optional)" value={name} onChange={(e) => setName(e.target.value)} />
      <input className={cn(field, "font-mono")} placeholder="5m, 2h, daily, weekdays 09:30, 0 9 * * 1-5, auto, webhook" value={schedule} onChange={(e) => setSchedule(e.target.value)} data-testid="new-loop-schedule" />
      <textarea className={cn(field, "min-h-28 resize-y")} placeholder="What to do each run" value={prompt} onChange={(e) => setPrompt(e.target.value)} data-testid="new-loop-prompt" />
      {isHook && (
        <label className="flex items-center gap-2 text-ui">
          <input type="checkbox" data-testid="new-loop-signed" checked={signed} onChange={(e) => setSigned(e.target.checked)} className="accent-[var(--accent)]" />
          Check signatures (HMAC, timestamp, replay window)
        </label>
      )}
      {err && <p className="text-caption text-danger">{err}</p>}
      {keys && <ShownOnce keys={keys} />}
      <button type="submit" disabled={!schedule.trim() || !!keys} className="self-start rounded-lg bg-accent px-3.5 py-1.5 text-ui font-medium text-accent-fg hover:opacity-90 disabled:opacity-40">
        Create loop
      </button>
    </form>
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
          className={cn(
            "fixed left-1/2 top-1/2 z-50 flex h-[min(44rem,calc(100vh-4rem))] w-[min(60rem,calc(100vw-4rem))] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border border-line bg-raised shadow-3 outline-none",
            "transition-[scale,opacity] duration-200 data-starting-style:scale-[0.98] data-starting-style:opacity-0 data-ending-style:scale-[0.98] data-ending-style:opacity-0",
          )}
        >
          <div className="flex items-center border-b border-line px-4 py-3">
            <Repeat className="mr-2 size-4 text-accent" />
            <Dialog.Title className="font-semibold">Loops</Dialog.Title>
            <span className="ml-2 text-caption text-faint">prompts that run again by themselves; no tokens between runs</span>
            <Dialog.Close className="ml-auto grid size-7 place-items-center rounded-md text-faint hover:bg-hover hover:text-fg"><X className="size-4" /></Dialog.Close>
          </div>
          <div className="flex min-h-0 flex-1">
            <div className="flex w-80 shrink-0 flex-col border-r border-line">
              <div className="min-h-0 flex-1 overflow-y-auto p-2" data-testid="loop-list">
                {loops.length === 0 && <Empty>No loops yet.</Empty>}
                {loops.map((l) => (
                  <div
                    key={l.id}
                    role="button"
                    tabIndex={0}
                    data-testid="loop-item"
                    onClick={() => setSel(l.id)}
                    onKeyDown={(e) => e.key === "Enter" && setSel(l.id)}
                    className={cn("group flex cursor-default items-center gap-2 rounded-lg px-2.5 py-2 outline-none hover:bg-hover", current?.id === l.id && "bg-panel")}
                  >
                    <span className={cn("size-2 shrink-0 rounded-full", l.last_status === "running" ? "bg-brass animate-pulse-dot" : l.enabled ? (l.last_status === "failed" ? "bg-danger" : "bg-ok") : "bg-line-strong")} />
                    <div className="min-w-0 flex-1">
                      <div className={cn("truncate text-ui", !l.enabled && "text-muted")}>{l.name}</div>
                      <div className="truncate text-micro text-faint">
                        {l.schedule_text} · {l.enabled ? (l.next_ms ? inMs(l.next_ms) : l.kind === "webhook" ? "on call" : "running") : (l.disabled_reason ?? "paused")}
                        {l.last_ms ? ` · ran ${ago(l.last_ms)}` : ""}
                      </div>
                    </div>
                    <span className="hidden items-center group-hover:flex">
                      <IconButton title="Run now" onClick={() => act(auto.runLoop(l.id))}><Play className="size-3.5" /></IconButton>
                      <IconButton title={l.enabled ? "Pause" : "Resume"} onClick={() => act(auto.patchLoop(l.id, { enabled: !l.enabled }))}>
                        {l.enabled ? <Pause className="size-3.5" /> : <Repeat className="size-3.5" />}
                      </IconButton>
                      <IconButton title="Delete" danger onClick={() => act(auto.deleteLoop(l.id))}><Trash2 className="size-3.5" /></IconButton>
                    </span>
                  </div>
                ))}
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
              {sel === "new" || !current ? <NewLoop onDone={setSel} /> : <History loop={current} />}
            </div>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
