// Open a file of the session in the owner's editor on the daemon's machine
// (POST /api/open), and the raw-image address of a file in the session's folder.
import { ExternalLink } from "lucide-react";
import { useState } from "react";
import { api, reportError } from "../lib/store.ts";

export const IMAGE = /\.(png|jpe?g|gif|webp)$/i;
export const rawFile = (sessionId: string, path: string) => `/api/sessions/${sessionId}/file?raw=1&path=${encodeURIComponent(path)}`;

export function openFile(sessionId: string, path: string, line?: number) {
  return api<{ ok: boolean; opened: "file" | "folder" }>("/api/open", { method: "POST", body: JSON.stringify({ session_id: sessionId, path, line }) });
}

export function OpenInEditor({ sessionId, path, line }: { sessionId: string; path: string; line?: number }) {
  const [said, setSaid] = useState<string | null>(null);
  return (
    <button
      type="button"
      data-testid="open-in-editor"
      title={said ?? "Open in your editor on this machine"}
      onClick={() => openFile(sessionId, path, line).then((r) => setSaid(r.opened === "folder" ? "Opened its folder (no editor is set)" : "Opened in your editor"), (e) => { setSaid((e as Error).message); if ((e as { status?: number }).status !== 403) reportError(e, { at: "open in editor" }); })}
      className="flex h-7 shrink-0 items-center gap-1 rounded-sm px-2 text-caption text-muted hover:bg-hover hover:text-fg"
    >
      <ExternalLink className="size-3.5" /> {said ? (said.startsWith("Opened") ? "Opened" : "Not opened") : "Open"}
    </button>
  );
}
