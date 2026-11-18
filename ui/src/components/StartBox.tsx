import { MessageSquare } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { actions, api, reportError, useStore } from "../lib/store.ts";
import { navigate, savePref, setUI, useUI } from "../lib/ui.ts";
import { ago, when } from "../lib/utils.ts";
import { Composer } from "./Composer.tsx";
import { Kbd } from "./Kbd.tsx";
import { SidebarButton } from "./SessionHeader.tsx";
import { WorkspacePicker } from "./WorkspacePicker.tsx";

// The start box: the folder, the model and the first message of a new session.
export function StartBox() {
  const defaultModel = useStore((s) => s.defaultModel);
  const sessions = useStore((s) => s.sessions);
  const newModel = useUI((s) => s.newModel);
  const chosen = useUI((s) => s.newWorkspace);
  const [fallback, setFallback] = useState("");
  useEffect(() => { api("/api/workspaces").then((r) => setFallback(r.recent[0]?.path ?? r.default)).catch(reportError); }, []);
  const workspace = chosen || fallback;
  const model = newModel || defaultModel;
  const recent = useMemo(
    () => Object.values(sessions).filter((s) => !s.archived && s.workspace === workspace).sort((a, b) => b.updated - a.updated).slice(0, 4),
    [sessions, workspace],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-12 shrink-0 items-center px-2 md:px-4"><SidebarButton /></div>
      <div className="flex flex-1 flex-col items-center overflow-y-auto px-4 pb-[max(1rem,env(safe-area-inset-bottom))] md:px-6">
        <div className="mt-auto w-full max-w-[46rem] pb-[8vh] pt-6 md:mb-auto md:mt-[18vh] md:pb-0 md:pt-0">
          <h1 className="mb-1.5 text-display font-semibold tracking-[-0.025em] text-fg">What should we work on?</h1>
          <p className="mb-6 text-base text-muted">Keel works in the folder below. Paste screenshots, mention files with @, and steer while it runs.</p>
          <div className="mb-2.5 flex flex-wrap items-center gap-2">
            <WorkspacePicker value={workspace} onChange={(p) => savePref("newWorkspace", p)} />
          </div>
          <div data-testid="new-composer">
            <Composer
              model={model}
              onModel={(id) => setUI({ newModel: id })}
              workspace={workspace}
              autoFocus
              onSend={async (t, images) => {
                const s = await actions.create(t, model || undefined, workspace || undefined, images);
                navigate({ name: "session", id: s.id });
              }}
            />
          </div>
          <div className="mt-3 hidden items-center gap-4 text-caption text-faint sm:flex">
            <span className="flex items-center gap-1.5"><Kbd keys="mod+k" /> search and commands</span>
            <span className="flex items-center gap-1.5"><Kbd keys="alt+m" /> model</span>
            <span className="flex items-center gap-1.5"><Kbd keys="mod+/" /> all shortcuts</span>
          </div>
          {recent.length > 0 && (
            <section className="mt-10">
              <h2 className="mb-2 text-caption font-medium text-faint">Recent in {workspace.split("/").pop()}</h2>
              <div className="flex flex-col">
                {recent.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => navigate({ name: "session", id: s.id })}
                    className="group flex h-10 items-center gap-3 border-b border-line text-left text-ui text-muted last:border-0 hover:text-fg"
                  >
                    <MessageSquare className="size-4 text-faint group-hover:text-accent" />
                    <span className="min-w-0 flex-1 truncate">{s.title || "New session"}</span>
                    <span className="text-caption tabular-nums text-faint" title={when(s.updated)}>{ago(s.updated)}</span>
                  </button>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
