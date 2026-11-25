import { useEffect, useState } from "react";
import { api, useStore } from "../lib/store.ts";

type Status = { page: string; incident?: { title: string; url: string } };

// The status page the owner named for the provider a waiting session runs on, and the
// incident open there (src/providers/status.ts). Nothing when no page is named.
export function ProviderStatus({ sessionId }: { sessionId: string }) {
  const model = useStore((s) => s.sessions[sessionId]?.model ?? "");
  const provider = model.includes(":") ? model.slice(0, model.indexOf(":")) : model;
  const [status, setStatus] = useState<Status | null>(null);
  useEffect(() => {
    if (!provider) return;
    let live = true;
    api<{ status: Status | null }>(`/api/providers/status?provider=${encodeURIComponent(provider)}`).then((r) => live && setStatus(r.status), () => {});
    return () => { live = false; };
  }, [provider]);
  if (!status) return null;
  const link = "text-accent-ink hover:underline";
  return (
    <span className="flex min-w-0 max-w-full basis-full items-center gap-x-3 text-caption text-muted" data-testid="provider-status">
      <a className={`${link} shrink-0`} href={status.page} target="_blank" rel="noreferrer" data-testid="provider-status-page">Status page</a>
      {status.incident && <a className={`${link} min-w-0 truncate`} href={status.incident.url} target="_blank" rel="noreferrer" title={status.incident.title} data-testid="provider-status-incident">Open incident: {status.incident.title}</a>}
    </span>
  );
}
