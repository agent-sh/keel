// Voice through parlar for one session: the header's mic shows where the voice
// is, and opens a small card to talk, mute or stop.
import { Mic, MicOff, Square, X } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { VoiceState } from "../../../src/integrations/voice.ts";
import { onFeature, reportError, failed } from "../lib/store.ts";
import { useUI } from "../lib/ui.ts";
import { cn } from "../lib/utils.ts";

const states = new Map<string, VoiceState>();
let open: string | null = null;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());
const subscribe = (f: () => void) => (subs.add(f), () => void subs.delete(f));
let version = 0;
const bump = () => { version++; emit(); };

export function setVoiceOpen(id: string | null) { open = id; bump(); }

export async function loadVoice(id: string) {
  try {
    const r = await fetch(`/api/sessions/${id}/voice`);
    if (r.ok) { states.set(id, await r.json()); bump(); }
  } catch (e) {
    reportError(e);
  }
}

onFeature({ frame: (f) => { if (f.name === "voice" && f.session_id) { states.set(f.session_id, f.data); bump(); } } });

const useVoice = (id?: string) => {
  useSyncExternalStore(subscribe, () => version);
  return id ? states.get(id) : undefined;
};

// The header icon: where the voice is, at a glance.
export function VoiceIcon() {
  const route = useUI((s) => s.route);
  const id = route.name === "session" ? route.id : undefined;
  const v = useVoice(id);
  useEffect(() => { if (id && !states.has(id)) void loadVoice(id); }, [id]);
  const here = !!v?.on && !!v.here;
  return (
    <span className={cn("relative grid place-items-center", here && "text-accent")} data-testid="voice-icon" data-here={here ? "1" : "0"}>
      {here && v?.mic_muted ? <MicOff className="size-4" /> : <Mic className="size-4" />}
      {here && v?.listening && !v.mic_muted && <span className="absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-accent animate-pulse-dot" />}
    </span>
  );
}

function phaseLine(v: VoiceState | undefined): string {
  if (!v) return "Reading";
  if (!v.available) return "parlar is not installed on this machine.";
  if (!v.running) return "parlar's daemon does not answer.";
  if (!v.on) return "Off. Talk turns the mic on and gives this session the voice.";
  if (!v.here) return "The voice is in another session. Talk brings it here.";
  if (v.mic_muted) return "Muted: the mic is closed; replies are still spoken.";
  return v.listening ? `Listening${v.phase ? ` · ${v.phase}` : ""}` : (v.phase ?? "On");
}

export function VoiceCard() {
  const id = useSyncExternalStore(subscribe, () => open);
  const v = useVoice(id ?? undefined);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => { setErr(""); if (id) void loadVoice(id); }, [id]);
  useEffect(() => {
    if (!id) return;
    const k = (e: KeyboardEvent) => e.key === "Escape" && setVoiceOpen(null);
    addEventListener("keydown", k);
    return () => removeEventListener("keydown", k);
  }, [id]);
  if (!id) return null;
  const act = async (action: string) => {
    setBusy(true);
    setErr("");
    try {
      const r = await fetch(`/api/sessions/${id}/voice`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action }) });
      const b = await r.json();
      if (!r.ok) {
        if (b.state) { states.set(id, b.state); bump(); }
        throw Object.assign(new Error(b.error ?? `HTTP ${r.status}`), { error_id: b.error_id, status: r.status });
      }
      states.set(id, b);
      bump();
    } catch (e) {
      setErr(failed(e, { at: "VoiceControl" }));
    } finally {
      setBusy(false);
    }
  };
  const here = !!v?.on && !!v.here;
  const btn = "inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-ui font-medium transition-colors disabled:opacity-40";
  return (
    <div data-testid="voice-card" role="dialog" aria-label="Voice" className="fixed right-4 top-14 z-50 w-80 rounded-xl border border-line bg-raised p-3.5 shadow-3 animate-in">
      <div className="flex items-center gap-2">
        <span className={cn("grid size-7 place-items-center rounded-full", here ? "bg-accent-soft text-accent" : "bg-sunken text-muted")}><Mic className="size-4" /></span>
        <span className="font-medium">Voice</span>
        <span className="text-caption text-faint">parlar</span>
        <button type="button" aria-label="Close" onClick={() => setVoiceOpen(null)} className="ml-auto grid size-6 place-items-center rounded-md text-faint hover:bg-hover hover:text-fg"><X className="size-3.5" /></button>
      </div>
      <p className="mt-2 text-caption text-muted" data-testid="voice-state">{phaseLine(v)}</p>
      {err && <p className="mt-2 rounded-md bg-danger-soft px-2 py-1.5 text-caption text-danger" data-testid="voice-error">{err}</p>}
      {v?.available && (
        <div className="mt-3 flex gap-2">
          {!here ? (
            <button type="button" disabled={busy} data-testid="voice-talk" onClick={() => act("talk")} className={cn(btn, "bg-accent text-accent-fg hover:opacity-90")}><Mic className="size-3.5" /> Talk</button>
          ) : (
            <>
              <button type="button" disabled={busy} data-testid="voice-mute" onClick={() => act(v.mic_muted ? "unmute" : "mute")} className={cn(btn, "border border-line-strong hover:bg-hover")}>
                {v.mic_muted ? <><Mic className="size-3.5" /> Unmute</> : <><MicOff className="size-3.5" /> Mute</>}
              </button>
              <button type="button" disabled={busy} data-testid="voice-stop" onClick={() => act("stop")} className={cn(btn, "text-danger hover:bg-danger-soft")}><Square className="size-3.5" /> Stop</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
