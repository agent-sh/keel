// Taking over a session another harness runs: the owner's yes first, then
// Keel copies it, ends it where it runs and goes on with it here. A copy whose
// original still runs says so above the composer, with Take over now.
import { ArrowDownToLine, CircleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { api, useStore, failed } from "../lib/store.ts";
import { every } from "../lib/clock.ts";
import { ago, clock } from "../lib/utils.ts";
import { navigate } from "../lib/ui.ts";
import { confirmAction } from "./Confirm.tsx";
import { ResumeCard } from "./ResumeFrom.tsx";

type Answer = { action: string; session: { id: string }; step?: string; stopped?: boolean; how?: string };

// Asks the owner, then takes over. `session` is the drive list's id of the original.
// `session` is the drive list's id, or { harness, id } for a source the agent view does not list.
export async function takeOver(session: string | { harness: string; id: string }, name: string, tool: string): Promise<Answer | null> {
  const yes = await confirmAction({
    title: `Take over "${name}"?`,
    body: `Keel copies it, ends it in ${tool} the way ${tool} ends a session, and goes on with it here. A session at work or on a prompt is copied and left running, and Keel says what to do first.`,
    action: "Take over",
    danger: true,
  });
  if (!yes) return null;
  return api<Answer>("/api/import/takeover", { method: "POST", body: JSON.stringify(typeof session === "string" ? { session } : session) });
}

export const TOOL: Record<string, string> = { claude: "Claude Code", codex: "Codex", agy: "Antigravity" };
// Whether Keel can copy a row of the drive list: a file it names here, or an Antigravity conversation by its id.
export const copyable = (s: { kind: string; host: string; transcript: boolean }) => !s.host && ((s.transcript && (s.kind === "claude" || s.kind === "codex")) || s.kind === "agy");

type Origin = {
  origin: null | {
    label: string; harness: string; source_id: string; imported_ms: number; synced_ms: number; went_on?: boolean;
    live_source: null | { id: string; since_ms: number };
    running?: { state: "working" | "waiting"; since: number; waiting_for?: string };
    machine?: { id: string; name: string; ssh: boolean };
  };
  source?: { exists: boolean; grew: boolean };
};

// What a Keel session says of where it came from, when it was imported or taken over: one line (the harness,
// the source's id, when), and under it what the source is doing now. The source has no row of its own anywhere
// (the sidebar, the import sheet, the running list): it is this mark. A source that went on is offered as
// continuing the import here; one still running says so, with Take over now.
export function LiveSourceBanner({ sessionId }: { sessionId: string }) {
  const [d, setD] = useState<Origin | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  // A session that was not copied from another tool never becomes one: it is
  // asked once. A copy is read again as its turns end and every few seconds
  // while it shows (what the source did meanwhile), not at every event of a running turn.
  const [plain, setPlain] = useState<string | null>(null);
  const ends = useStore((s) => (plain === sessionId ? 0 : s.events[sessionId]?.findLast((e) => e.kind === "turn_end")?.seq ?? 0));
  const o = d?.origin ?? null;
  const read = () => api<Origin>(`/api/sessions/${sessionId}/origin`).then((r) => { setD(r); if (!r.origin) setPlain(sessionId); }, () => setD(null));
  useEffect(() => {
    if (plain === sessionId) return;
    read();
  }, [sessionId, ends, plain]);
  useEffect(() => (o ? every(5000, () => { read(); }) : undefined), [o?.source_id, sessionId]);
  // A copy from a machine reached over ssh: while its original still runs there, its state and the choices to resume it here.
  if (o?.machine?.ssh) return <ResumeCard target={{ machine: o.machine.id, harness: o.harness, id: o.source_id }} tool={o.label} machineName={o.machine.name} every={10_000} />;
  if (!o) return null;
  const live = o.live_source;
  const running = o.running;
  const tool = (live && TOOL[live.id.split(":")[0]!]) || TOOL[o.harness] || o.label;
  const grew = !!d?.source?.grew;
  const gone = d?.source?.exists === false;
  const guard = (f: () => Promise<void>) => async () => {
    setBusy(true);
    try { await f(); } catch (e) { setNote(failed(e, { at: "OriginMark" })); } finally { setBusy(false); }
  };
  return (
    <div data-testid="origin" className="mb-2 flex flex-col gap-1.5">
      <div className="k-origin" data-testid="origin-mark" data-harness={o.harness} title={`Imported from ${o.label} (${o.source_id}) ${clock(o.imported_ms, { date: true })}`}>
        <ArrowDownToLine aria-hidden="true" />
        <span className="min-w-0 truncate">
          From {o.label}<span className="k-origin-id" data-testid="origin-id"> {o.source_id.slice(0, 8)}</span> · imported {ago(o.imported_ms)}
          {!gone && !grew && !o.went_on && o.synced_ms > o.imported_ms ? ` · brought up to date ${ago(o.synced_ms)}` : ""}
        </span>
        {grew && !o.went_on && !live && !running && (
          <button type="button" data-testid="origin-resume" disabled={busy} className="k-btn shrink-0"
            title="The original gained turns since: add them to this session"
            onClick={guard(async () => {
              await api("/api/import", { method: "POST", body: JSON.stringify({ mode: "update", session_id: sessionId }) });
              setNote("");
              await read();
            })}>
            Resume the import
          </button>
        )}
        {grew && o.went_on && <span className="shrink-0 text-faint" data-testid="origin-went-on" title="This session took turns here, so the original's later turns would land after them">the original went on · not added</span>}
      </div>
      {(live || running) && (
        <div data-testid="live-source" className="flex items-start gap-2.5 rounded-xl border border-warn/40 bg-raised px-3 py-2 text-caption">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-warn" />
          <div className="min-w-0 flex-1">
            <p className="text-fg">The original still runs in {tool}{running ? ` (${running.state}${running.waiting_for ? `: ${running.waiting_for}` : ""})` : ""}.</p>
            <p className="text-muted">{note || "This is the Keel copy. Leave what the original may be driving alone until it ends, or take it over once it is idle."}</p>
          </div>
          <button
            type="button"
            data-testid="take-over-now"
            disabled={busy}
            onClick={guard(async () => {
              const r = await takeOver(live ? live.id : { harness: o.harness, id: o.source_id }, "the original", tool);
              if (r) {
                setNote(r.action === "snapshot" ? r.step ?? "" : "");
                if (r.session.id !== sessionId) navigate({ name: "session", id: r.session.id });
                else await read();
              }
            })}
            className="k-btn shrink-0"
          >
            Take over now
          </button>
        </div>
      )}
      {!live && !running && note && <p className="text-caption text-danger" data-testid="origin-note">{note}</p>}
    </div>
  );
}
