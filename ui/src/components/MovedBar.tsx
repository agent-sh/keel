// A session that moved to Claude Code or Codex (src/server/routes/continue.ts): over its box, where it went and
// when, whether a terminal opened on it, and the command that resumes it there, to copy or to open again.
// The conversation above stays readable; a message typed here goes on in Keel as before.
import { Check, Copy, SquareTerminal } from "lucide-react";
import { useState } from "react";
import type { Moved } from "../../../src/core/types.ts";
import { copyOrSay } from "../lib/copy.ts";
import { HARNESS_WORD, openAgain } from "../lib/move-out.ts";
import { failed } from "../lib/store.ts";
import { clock, cn } from "../lib/utils.ts";

export function MovedBar({ id, moved }: { id: string; moved: Moved }) {
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState("");
  const where = HARNESS_WORD[moved.harness];
  const again = async () => {
    setBusy(true);
    setErr("");
    try { await openAgain(id); } catch (e) { setErr(failed(e, { at: "MovedBar" })); } finally { setBusy(false); }
  };
  return (
    <section className="mb-2 rounded-lg border border-line bg-raised px-3 py-2.5" data-testid="moved-bar" data-opened={moved.opened ? "" : undefined} aria-label={`Moved to ${where}`}>
      <p className="text-ui font-medium" data-testid="moved-said">
        {moved.original ? `Resumed its original in ${where}` : `Moved to ${where}`}
        <span className="font-normal text-muted"> at {clock(moved.at)}. It goes on there; here it is archived.</span>
      </p>
      <p className={cn("mt-0.5 text-caption", moved.opened ? "text-muted" : "text-warn")} data-testid="moved-terminal">
        {moved.opened ? `A terminal opened on it (${moved.how}).` : `No terminal opened: ${moved.why}. Paste the command into one.`}
      </p>
      <div className="mt-2 flex items-center gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2 rounded-md bg-sunken px-2.5 py-1.5">
          {/* The command, then its folder: the copy takes both as one line to paste. */}
          <code className="shrink-0 font-mono text-caption" data-testid="moved-command" title={moved.shell_command}>{moved.resume}</code>
          <span className="min-w-0 flex-1 truncate text-caption text-faint" data-testid="moved-folder" title={moved.cwd}>in {moved.cwd}</span>
          <button type="button" aria-label="Copy the command" onClick={(e) => copyOrSay(moved.shell_command, e.currentTarget).then((ok) => { if (ok) { setCopied(true); setTimeout(() => setCopied(false), 1200); } })} className={cn("grid size-6 place-items-center rounded-sm text-faint hover:text-fg", copied && "text-ok")}>
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          </button>
        </div>
        <button type="button" className="k-btn" data-testid="moved-open" disabled={busy} aria-busy={busy || undefined} onClick={() => void again()}>
          <SquareTerminal aria-hidden="true" />Open a terminal
        </button>
      </div>
      {moved.notes?.map((n) => <p key={n} className="mt-1.5 text-caption text-muted" data-testid="moved-note">{n}</p>)}
      {err && <p className="mt-1.5 text-caption text-danger" data-testid="moved-error">{err}</p>}
    </section>
  );
}
