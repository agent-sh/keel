// Summarize a part of the conversation from a prompt's row: "from here" (the
// prompt and what follows become a summary; the prompt comes back to the
// message box) or "up to here" (what came before becomes a summary). An
// optional line says what the summary must keep.
import { Dialog } from "@base-ui/react/dialog";
import { useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { api, reportError } from "../lib/store.ts";
import { seedComposer } from "../lib/ui.ts";
import { cn } from "../lib/utils.ts";

type Ask = { sessionId: string; eventId: string; direction: "from" | "up_to" };
let current: Ask | null = null;
const subs = new Set<() => void>();
const set = (a: Ask | null) => { current = a; subs.forEach((f) => f()); };

let mounted = false;
export function summarize(a: Ask) {
  if (!mounted) {
    mounted = true;
    const el = document.createElement("div");
    document.body.append(el);
    createRoot(el).render(<Host />);
  }
  set(a);
}

const TEXT = {
  from: { title: "Summarize from here", body: "This prompt and everything after it become one summary the model reads in their place. What came before stays as it was. The prompt comes back to the message box; the full conversation stays on its branch." },
  up_to: { title: "Summarize up to here", body: "Everything before this prompt becomes one summary the model reads in its place. This prompt and what follows stay as they were; the full conversation stays readable." },
};

function Host() {
  const ask = useSyncExternalStore((f) => (subs.add(f), () => void subs.delete(f)), () => current);
  const [focus, setFocus] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = () => { if (!busy) { set(null); setFocus(""); setError(null); } };
  const go = async () => {
    if (!ask) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ prompt_text?: string }>(`/api/sessions/${ask.sessionId}/summarize`, { method: "POST", body: JSON.stringify({ event_id: ask.eventId, direction: ask.direction, focus: focus.trim() || undefined }) });
      if (r.prompt_text) seedComposer(r.prompt_text, ask.sessionId);
      setBusy(false);
      set(null);
      setFocus("");
    } catch (e) {
      setBusy(false);
      setError((e as Error).message);
      if ((e as { status?: number }).status !== 400 && (e as { status?: number }).status !== 409) reportError(e, { at: "summarize" });
    }
  };
  const t = ask ? TEXT[ask.direction] : TEXT.from;
  return (
    <Dialog.Root open={!!ask} onOpenChange={(o) => !o && close()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-overlay transition-opacity data-starting-style:opacity-0 data-ending-style:opacity-0" />
        <Dialog.Popup data-testid="summarize-dialog" className="k-dialog rounded-xl border border-line bg-raised shadow-3">
          <Dialog.Title className="k-dialog-title px-[var(--k-dialog-pad)] pt-[var(--k-dialog-pad)] text-read font-semibold">{t.title}</Dialog.Title>
          <div className="k-dialog-body mt-1.5 px-[var(--k-dialog-pad)] pb-1">
            <Dialog.Description className="text-ui text-muted">{t.body}</Dialog.Description>
            <label className="mt-4 block text-caption text-muted" htmlFor="summarize-focus">Keep above all (optional)</label>
            <textarea id="summarize-focus" data-testid="summarize-focus" value={focus} onChange={(e) => setFocus(e.target.value)} rows={2} disabled={busy}
              className="mt-1 block w-full resize-none rounded-md border border-line bg-sunken px-2 py-1.5 text-ui outline-none placeholder:text-faint focus:ring-2 focus:ring-ring" placeholder="The API decisions, the failing test names" />
            {error && <p className="mt-2 text-caption text-danger" role="alert">{error}</p>}
          </div>
          <div className="k-dialog-foot px-[var(--k-dialog-pad)] pb-[var(--k-dialog-pad)] pt-3">
            <Dialog.Close disabled={busy} className="k-btn k-btn-lg">Cancel</Dialog.Close>
            <button type="button" data-testid="summarize-go" onClick={go} disabled={busy}
              className={cn("h-8 rounded-md bg-accent px-3 text-ui font-medium text-accent-fg hover:bg-accent-hover", busy && "opacity-60")}>
              {busy ? "Summarizing" : "Summarize"}
            </button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
