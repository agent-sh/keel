import { FlaskConical, Loader2, Play } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { Session } from "../../../src/core/types.ts";
import type { BeforeRun } from "../../../src/checks/before-run.ts";
import type { FileResult } from "../../../src/checks/before.ts";
import { api, onFeature, failed, reportError } from "../lib/store.ts";
import { cn } from "../lib/utils.ts";

const TONE: Record<FileResult["state"], string> = {
  fails: "bg-ok/15 text-ok",
  passes: "bg-warn/15 text-warn",
  unrun: "bg-sunken text-muted",
  running: "bg-accent-soft text-accent",
  waiting: "bg-sunken text-faint",
};
const WORDS: Record<FileResult["state"], string> = {
  fails: "fails before: yes",
  passes: "passes without the change",
  unrun: "could not run",
  running: "running on the base",
  waiting: "waiting",
};
const secs = (ms: number | null) => (ms === null ? "" : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

// The session's new and changed tests, run on its base without its change:
// a test that passes there does not prove the change (src/checks/before.ts).
export function FailsBefore({ session }: { session: Session }) {
  const [run, setRun] = useState<BeforeRun | null>(null);
  const [tests, setTests] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const load = useCallback(() => api<{ run: BeforeRun | null; tests: boolean }>(`/api/sessions/${session.id}/fails-before`).then((r) => { setRun(r.run); setTests(r.tests); }).catch(reportError), [session.id]);
  useEffect(() => {
    load();
    return onFeature({ frame: (f) => { if (f.name === "fails_before" && f.session_id === session.id) setRun(f.data); }, reconnect: load });
  }, [load]);
  if (!tests && !run) return null;
  const start = async () => {
    setBusy(true);
    setNote("");
    try {
      const r = await api<{ run: BeforeRun | null }>(`/api/sessions/${session.id}/fails-before`, { method: "POST" });
      if (r.run) setRun(r.run);
      else setNote("No test file this repository's checks run is added or changed over the base.");
    } catch (e) {
      setNote(failed(e, { at: "FailsBefore" }));
    } finally {
      setBusy(false);
    }
  };
  const going = run?.state === "running";
  const counts = run ? (["fails", "passes", "unrun"] as const).map((s) => [s, run.results.filter((r) => r.state === s).length] as const).filter(([, n]) => n) : [];
  return (
    <section className="k-fails-before rounded-xl border border-line bg-raised p-3" data-testid="fails-before" data-state={run?.state ?? "none"}>
      <div className="flex items-center gap-2 px-0.5">
        <FlaskConical className="size-4 text-accent" />
        <h3 className="text-ui font-medium">Tests without the change</h3>
        <span className="min-w-0 truncate text-caption text-faint">
          {run?.base ? <>new and changed tests on <span className="font-mono">{run.base}</span>{run.merge_base ? <> at <span className="font-mono">{run.merge_base.slice(0, 9)}</span></> : ""}</> : "new and changed tests, run on the base"}
        </span>
        <button data-testid="fails-before-run" onClick={start} disabled={busy || going} title="Run the new and changed test files on the base, with only the test files applied"
          className="ml-auto inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg px-2 text-caption text-muted hover:bg-hover hover:text-fg disabled:opacity-50">
          {busy || going ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />} {run ? "Run again" : "Run"}
        </button>
      </div>
      {note && <p className="mt-2 px-0.5 text-caption text-muted" data-testid="fails-before-note">{note}</p>}
      {run && (
        <>
          {counts.length > 0 && (
            <p className="mt-1 px-0.5 text-micro text-faint" data-testid="fails-before-counts">
              {counts.map(([s, n]) => `${n} ${s === "fails" ? "fail before" : s === "passes" ? "pass without the change" : "could not run"}`).join(" · ")}
            </p>
          )}
          <ul className="mt-2 flex flex-col divide-y divide-line rounded-lg border border-line bg-bg">
            {run.results.map((r) => (
              <li key={r.path} className="flex items-start gap-2.5 px-3 py-1.5" data-testid="fails-before-file" data-state={r.state} data-path={r.path}>
                <span className={cn("mt-0.5 shrink-0 rounded-full px-2 py-0.5 text-micro font-medium", TONE[r.state])} data-testid="fails-before-state">{WORDS[r.state]}</span>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-caption" title={r.command}>{r.path}</div>
                  {r.why && r.state !== "passes" && <p className="text-caption text-muted" data-testid="fails-before-why">{r.why}</p>}
                  {r.state === "passes" && <p className="text-caption text-muted">It passes on the base, so it does not show what the change fixes{r.why ? ` (${r.why})` : ""}.</p>}
                </div>
                {r.ms !== null && <span className="mt-0.5 shrink-0 font-mono text-micro text-faint" data-testid="fails-before-cost" title="Wall time, and processor time of the run">{secs(r.ms)}{r.cpu_ms !== null ? ` · cpu ${secs(r.cpu_ms)}` : ""}</span>}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
