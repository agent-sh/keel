// Taking over a session another harness runs: the owner's yes first, then
// Keel copies it, ends it where it runs and goes on with it here. A copy whose
// original still runs says so above the composer, with Take over now.
import { CircleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { api, useStore, failed } from "../lib/store.ts";
import { navigate } from "../lib/ui.ts";
import { confirmAction } from "./Confirm.tsx";
import { ResumeCard } from "./ResumeFrom.tsx";

type Answer = { action: string; session: { id: string }; step?: string; stopped?: boolean; how?: string };

// Asks the owner, then takes over. `session` is the drive list's id of the original.
export async function takeOver(session: string, name: string, tool: string): Promise<Answer | null> {
  const yes = await confirmAction({
    title: `Take over "${name}"?`,
    body: `Keel copies it, ends it in ${tool} the way ${tool} ends a session, and goes on with it here. A session at work or on a prompt is copied and left running, and Keel says what to do first.`,
    action: "Take over",
    danger: true,
  });
  if (!yes) return null;
  return api<Answer>("/api/import/takeover", { method: "POST", body: JSON.stringify({ session }) });
}

export const TOOL: Record<string, string> = { claude: "Claude Code", codex: "Codex", agy: "Antigravity" };
// Whether Keel can copy a row of the drive list: a file it names here, or an Antigravity conversation by its id.
export const copyable = (s: { kind: string; host: string; transcript: boolean }) => !s.host && ((s.transcript && (s.kind === "claude" || s.kind === "codex")) || s.kind === "agy");

type Origin = { origin: null | { label: string; harness: string; source_id: string; live_source: null | { id: string; since_ms: number }; machine?: { id: string; name: string; ssh: boolean } } };

export function LiveSourceBanner({ sessionId }: { sessionId: string }) {
  const [o, setO] = useState<Origin["origin"]>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  // A session that was not copied from another tool never becomes one: it is
  // asked once. A copy is read again as its turns end (a later list or a
  // take-over clears the mark), not at every event of a running turn.
  const [plain, setPlain] = useState<string | null>(null);
  const ends = useStore((s) => (plain === sessionId ? 0 : s.events[sessionId]?.findLast((e) => e.kind === "turn_end")?.seq ?? 0));
  useEffect(() => {
    if (plain === sessionId) return;
    api<Origin>(`/api/sessions/${sessionId}/origin`).then((r) => { setO(r.origin); if (!r.origin) setPlain(sessionId); }, () => setO(null));
  }, [sessionId, ends, plain]);
  // A copy from a machine reached over ssh: while its original still runs there, its state and the choices to resume it here.
  if (o?.machine?.ssh) return <ResumeCard target={{ machine: o.machine.id, harness: o.harness, id: o.source_id }} tool={o.label} machineName={o.machine.name} every={10_000} />;
  const live = o?.live_source;
  if (!live) return null;
  const tool = TOOL[live.id.split(":")[0]!] ?? o.label;
  return (
    <div data-testid="live-source" className="mb-2 flex items-start gap-2.5 rounded-xl border border-warn/40 bg-raised px-3 py-2 text-caption">
      <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-warn" />
      <div className="min-w-0 flex-1">
        <p className="text-fg">The original still runs in {tool}.</p>
        <p className="text-muted">{note || "This is a copy. Leave what the original may be driving alone until it ends, or take it over once it is idle."}</p>
      </div>
      <button
        type="button"
        data-testid="take-over-now"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            const r = await takeOver(live.id, "the original", tool);
            if (r) {
              setNote(r.action === "snapshot" ? r.step ?? "" : "");
              if (r.session.id !== sessionId) navigate({ name: "session", id: r.session.id });
            }
          } catch (e) {
            setNote(failed(e, { at: "TakeOver" }));
          } finally {
            setBusy(false);
          }
        }}
        className="k-btn shrink-0"
      >
        Take over now
      </button>
    </div>
  );
}
