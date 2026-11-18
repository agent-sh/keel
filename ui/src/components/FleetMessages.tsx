// Messages between sessions in the workbench: one in the transcript (another
// session's text, not the owner's), and the ones held for the owner above the
// composer, with deliver and drop.
import { Inbox, MessageSquareShare, Send, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { StoredEvent } from "../../../src/core/types.ts";
import { splitId } from "../lib/fleet-ids.ts";
import { api, onFeature, reportError } from "../lib/store.ts";
import { ago, cn, when } from "../lib/utils.ts";
import { Markdown } from "./Markdown.tsx";

const PREFIX = '<external_input source="peer_session"';
const unesc = (s: string) => s.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

export const isPeerMessage = (e: StoredEvent) => e.kind === "user" && (e.data.kind === "peer" || String(e.data.text ?? "").startsWith(PREFIX));

function parse(text: string) {
  const from = unesc(text.match(/from="([^"]*)"/)?.[1] ?? "another session");
  const body = text.replace(/^<external_input[^>]*>\n[^\n]*\n\n/, "").replace(/\n<\/external_input>\s*$/, "");
  return { from, body };
}

export function PeerMessage({ e }: { e: StoredEvent }) {
  const { from, body } = parse(String(e.data.text ?? ""));
  return (
    <div id={`e-${e.id}`} className="flex flex-col gap-1.5 animate-in" data-testid="peer-message" data-event-id={e.id}>
      <div className="flex items-center gap-1.5 text-micro font-medium text-faint">
        <MessageSquareShare className="size-3.5 text-accent" />
        From <span className="text-muted">{from}</span>
        <span className="font-normal" title={when(e.ts)}>· {ago(e.ts)}</span>
        <span className="font-normal">· another session, not you</span>
      </div>
      <div className="rounded-lg border border-dashed border-line-strong bg-sunken/60 px-4 py-2.5 text-read leading-relaxed text-fg">
        <Markdown text={body} />
      </div>
    </div>
  );
}

type Held = { id: string; created_ms: number; text: string; reason?: string; from: { title?: string; session_id: string; machine?: string } };

const base = (sessionId: string) => {
  const r = splitId(sessionId);
  return r ? { prefix: `/api/fleet/machines/${r.machine}/api`, id: r.id } : { prefix: "/api", id: sessionId };
};

export function HeldMessages({ sessionId }: { sessionId: string }) {
  const [held, setHeld] = useState<Held[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    const { prefix, id } = base(sessionId);
    const load = () => api<{ messages: Held[] }>(`${prefix}/fleet/messages?session_id=${id}&state=held`).then((r) => setHeld(r.messages)).catch(reportError);
    load();
    return onFeature({ frame: (f) => { if (f.name === "fleet_message" && f.session_id === sessionId) load(); }, reconnect: load });
  }, [sessionId]);
  if (!held.length) return null;
  const decide = async (id: string, decision: "deliver" | "drop") => {
    setBusy(id);
    try {
      await api(`${base(sessionId).prefix}/fleet/messages/${id}`, { method: "POST", body: JSON.stringify({ decision }) });
      setHeld((h) => h.filter((m) => m.id !== id));
    } catch (e) { reportError(e); } finally { setBusy(null); }
  };
  return (
    <div className="mb-2 flex flex-col gap-1.5" data-testid="held-messages">
      {held.map((m) => (
        <div key={m.id} className="rounded-lg border border-brass/40 bg-brass-soft/50 px-3 py-2.5 shadow-1" data-testid="held-message">
          <div className="flex items-center gap-2 text-caption">
            <Inbox className="size-3.5 shrink-0 text-brass" />
            <span className="font-medium text-fg">Message from {m.from.title || m.from.session_id}{m.from.machine ? ` on ${m.from.machine}` : ""}</span>
            <span className="text-faint" title={when(m.created_ms)}>{ago(m.created_ms)}</span>
            <span className="ml-auto flex gap-1">
              <button type="button" disabled={busy === m.id} onClick={() => decide(m.id, "drop")} className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-caption text-muted hover:bg-hover hover:text-fg disabled:opacity-50" data-testid="held-drop">
                <X className="size-3.5" /> Drop
              </button>
              <button type="button" disabled={busy === m.id} onClick={() => decide(m.id, "deliver")} className={cn("inline-flex h-7 items-center gap-1 rounded-md bg-accent px-2.5 text-caption font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-50")} data-testid="held-deliver">
                <Send className="size-3.5" /> Deliver
              </button>
            </span>
          </div>
          {m.reason && <div className="mt-0.5 pl-5.5 text-micro text-muted">Held because {m.reason}.</div>}
          <p className="mt-1.5 line-clamp-3 pl-5.5 text-ui text-fg whitespace-pre-wrap">{m.text}</p>
        </div>
      ))}
    </div>
  );
}
