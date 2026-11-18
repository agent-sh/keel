import { Component, useCallback, useEffect, useState, type ReactNode } from "react";
import { Composer } from "./components/Composer.tsx";
import { ErrorsPanel } from "./components/ErrorsPanel.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { Transcript } from "./components/Transcript.tsx";
import { actions, connect, reportError, useStore } from "./lib/store.ts";
import { fmtTokens } from "./lib/utils.ts";

class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  override componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    reportError(error, { kind: "react", componentStack: info.componentStack });
  }
  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="m-auto max-w-md p-8 text-center">
        <p className="font-semibold">Something broke in the page.</p>
        <p className="mt-1 text-[13px] text-muted">{this.state.error.message}</p>
        <button className="mt-4 rounded-lg bg-accent px-3 py-1.5 text-accent-fg" onClick={() => this.setState({ error: null })}>Try again</button>
      </div>
    );
  }
}

const routeId = () => location.pathname.match(/^\/s\/([\w-]+)/)?.[1] ?? null;

function useTheme() {
  const [theme, setTheme] = useState<"light" | "dark">(() => (document.documentElement.classList.contains("dark") ? "dark" : "light"));
  const toggle = useCallback(() => {
    setTheme((t) => {
      const next = t === "dark" ? "light" : "dark";
      const root = document.documentElement;
      root.classList.add("theme-switch");
      root.classList.toggle("dark", next === "dark");
      requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove("theme-switch")));
      localStorage.setItem("keel.theme", next);
      return next;
    });
  }, []);
  return [theme, toggle] as const;
}

export function App() {
  const [current, setCurrent] = useState<string | null>(routeId);
  const [errorsOpen, setErrorsOpen] = useState(false);
  const [theme, toggleTheme] = useTheme();
  const defaultModel = useStore((s) => s.defaultModel);
  const [newModel, setNewModel] = useState("");
  const session = useStore((s) => (current ? s.sessions[current] : undefined));

  useEffect(() => {
    connect();
    actions.loadSessions().catch(reportError);
    actions.loadModels().catch(reportError);
    actions.loadErrors().catch(reportError);
    const onPop = () => setCurrent(routeId());
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    if (current) actions.loadSession(current).catch(reportError);
    document.title = session?.title ? `${session.title} · Keel` : "Keel";
  }, [current, session?.title]);

  const go = (id: string | null) => {
    history.pushState(null, "", id ? `/s/${id}` : "/");
    setCurrent(id);
  };

  const model = newModel || defaultModel;

  return (
    <Boundary>
      <div className="flex h-full">
        <Sidebar current={current} onPick={go} onNew={() => go(null)} onErrors={() => setErrorsOpen(true)} theme={theme} onTheme={toggleTheme} />
        <main className="flex min-w-0 flex-1 flex-col">
          {session ? (
            <>
              <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line px-5">
                <h1 className="min-w-0 truncate text-[14px] font-medium" data-testid="session-title">{session.title || "New session"}</h1>
                <span className="truncate text-[12px] text-faint font-mono">{session.workspace}</span>
                <span className="ml-auto text-[12px] text-faint tabular-nums" title="Tokens this session: input (incl. cached) / output">
                  {fmtTokens(session.usage.input + session.usage.cache_read + session.usage.cache_write)} / {fmtTokens(session.usage.output)}
                </span>
              </header>
              <Transcript sessionId={session.id} />
              <div className="mx-auto w-full max-w-3xl px-5 pb-5">
                <Composer
                  working={session.phase === "working"}
                  model={session.model}
                  onModel={(m) => actions.patch(session.id, { model: m })}
                  onSend={(t) => actions.send(session.id, t)}
                  onStop={() => actions.interrupt(session.id)}
                  autoFocus
                />
              </div>
            </>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center px-5 pb-[12vh]">
              <h1 className="mb-6 text-[26px] font-semibold tracking-tight">What are we building?</h1>
              <div className="w-full max-w-2xl" data-testid="new-composer">
                <Composer
                  model={model}
                  onModel={setNewModel}
                  autoFocus
                  onSend={async (t) => {
                    const s = await actions.create(t, model || undefined);
                    go(s.id);
                  }}
                />
              </div>
            </div>
          )}
        </main>
      </div>
      <ErrorsPanel open={errorsOpen} onOpenChange={setErrorsOpen} />
    </Boundary>
  );
}
