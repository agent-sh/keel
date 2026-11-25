// Side panel: the dev servers a session's processes run, opened through the
// portal in a sandboxed frame, with an element picker that hands what was
// clicked to the message box.
import { Crosshair, ExternalLink, Globe, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Session } from "../../../src/core/types.ts";
import { splitId } from "../lib/fleet-ids.ts";
import { machineName } from "../lib/fleet.ts";
import { pointSeed } from "../lib/preview-point.ts";
import { api, reportError } from "../lib/store.ts";
import { seedComposer } from "../lib/ui.ts";
import { cn } from "../lib/utils.ts";
import { ContentFrame } from "./ContentFrame.tsx";

type Port = { port: number; pid: number; process: string; open: boolean; point?: boolean; url?: string; holder?: { session_id: string; title: string; mine: boolean } };
type Range = { from: number; to: number };

export function PreviewPanel({ session }: { session: Session }) {
  const [ports, setPorts] = useState<Port[] | null>(null);
  // The ten ports this session's commands are given in $KEEL_PORT, when its sandbox is off.
  const [range, setRange] = useState<Range | null>(null);
  const [shown, setShown] = useState<number | null>(null);
  const [n, setN] = useState(0);
  const frame = useRef<HTMLIFrameElement>(null);
  // A session of another daemon: its daemon lists the ports (through the
  // forwarder), and the page opens them through this daemon's remote portal.
  const remote = splitId(session.id);
  const local = (p: Port): Port => (remote && p.url ? { ...p, url: p.url.replace(/^\/portal\//, `/fleet-portal/${remote.machine}/`) } : p);
  // A session deleted meanwhile (here or on its daemon) has no ports: not an error.
  const load = () => api<{ ports: Port[]; range?: Range | null }>(`/api/sessions/${session.id}/portal`).then((r) => { setPorts(r.ports.map(local)); setRange(r.range ?? null); }).catch((e) => ((e as any)?.status === 404 ? setPorts([]) : reportError(e)));
  useEffect(() => {
    load();
    const t = setInterval(load, 5000); // a dev server the session starts shows up within seconds
    return () => clearInterval(t);
  }, [session.id]);
  // What the picker in the frame says. The frame's page is not Keel's: its words reach the
  // message box only while the owner is picking, with the pointer over the frame (lib/preview-point.ts).
  const picking = !!ports?.find((p) => p.port === shown && p.open)?.point;
  useEffect(() => {
    const on = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow || !e.data || typeof e.data !== "object" || shown === null) return;
      const by = { picking, over: !!frame.current?.matches(":hover") };
      if (e.data.type === "keel_point") {
        const seed = pointSeed(e.data, shown, remote ? (machineName(remote.machine) ?? remote.machine) : "", by);
        if (seed) seedComposer(seed);
      }
      if (e.data.type === "keel_point_exit" && picking) toggle(shown, true, false);
    };
    addEventListener("message", on);
    return () => removeEventListener("message", on);
  }, [shown, picking]);
  const toggle = async (port: number, open: boolean, point = false) => {
    const r = await api<{ ports: Port[] }>(`/api/sessions/${session.id}/portal`, { method: "POST", body: JSON.stringify({ port, open, point }) }).catch((e) => (reportError(e), null));
    if (!r) return;
    setPorts(r.ports.map(local));
    setShown(open ? port : null);
    setN((x) => x + 1);
  };
  const cur = ports?.find((p) => p.port === shown && p.open);
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="preview-panel">
      <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-3 py-2">
        {range && <span className="text-caption text-muted" data-testid="preview-range" title="Commands of this session get this range as $KEEL_PORT (the first) and $KEEL_PORT_END, so its dev server does not meet another session's on one port">Ports {range.from} to {range.to} for this session</span>}
        {ports?.length === 0 && <span className="text-caption text-faint">No dev server: when a process of this session listens on a loopback port, it shows here.</span>}
        {ports?.map((p) => (
          <button
            key={p.port}
            type="button"
            data-testid="preview-port"
            data-port={p.port}
            onClick={() => (p.open && shown === p.port ? toggle(p.port, false) : toggle(p.port, true, p.point))}
            className={cn("inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-caption", p.open && shown === p.port ? "border-accent bg-accent-soft text-accent-ink" : "border-line text-muted hover:text-fg")}
            title={`${p.process} (pid ${p.pid})${p.holder ? (p.holder.mine ? ", in this session's port range" : `, in the port range of ${p.holder.title || "another session"}`) : ""}`}
          >
            <Globe className="size-3.5" /> :{p.port} <span className="text-faint">{p.process}</span>
            {p.holder && !p.holder.mine && <span className="text-warn" data-testid="preview-holder">in {p.holder.title || "another session"}'s range</span>}
          </button>
        ))}
        {cur && (
          <span className="ml-auto flex items-center gap-0.5">
            <button type="button" title="Pick an element for the message box (Esc ends it)" aria-pressed={!!cur.point} data-testid="preview-point" onClick={() => toggle(cur.port, true, !cur.point)} className={cn("grid size-7 place-items-center rounded-md hover:bg-hover", cur.point ? "text-accent" : "text-faint")}><Crosshair className="size-3.5" /></button>
            <button type="button" title="Reload" onClick={() => setN((x) => x + 1)} className="grid size-7 place-items-center rounded-md text-faint hover:bg-hover hover:text-fg"><RefreshCw className="size-3.5" /></button>
            <a href={cur.url} target="_blank" rel="noreferrer" title="Open in a tab" className="grid size-7 place-items-center rounded-md text-faint hover:bg-hover hover:text-fg"><ExternalLink className="size-3.5" /></a>
          </span>
        )}
      </div>
      {cur ? (
        <ContentFrame
          what="preview"
          key={`${cur.url}-${n}`}
          frameRef={frame}
          src={cur.url}
          title={`Preview of port ${cur.port}`}
          data-testid="preview-frame"
          sandbox="allow-scripts allow-forms allow-modals allow-popups allow-downloads"
          className="min-h-0 flex-1 bg-white"
        />
      ) : (
        ports && ports.length > 0 && <p className="p-4 text-ui text-faint">Pick a port to open it here. It stays open until you close it or the daemon restarts.</p>
      )}
    </div>
  );
}
