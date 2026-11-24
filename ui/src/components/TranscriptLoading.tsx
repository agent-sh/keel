// What a session shows while its conversation is on its way: the words, and
// the shape of what is coming (a prompt, a reply, a tool row), instead of an
// empty pane that reads as an empty session. It appears after a moment, so a
// load that is quick shows nothing in between.
import { useAppSays } from "./Stale.tsx";

export function TranscriptLoading({ unreached = false }: { unreached?: boolean }) {
  const said = useAppSays() ?? "Keel is not reachable";
  const line = "h-3 rounded-sm bg-sunken animate-pulse-dot";
  return (
    <div className="min-h-0 flex-1 overflow-hidden" role="status" aria-busy={!unreached} data-testid="transcript-loading">
      <div className="mx-auto flex max-w-[48rem] flex-col gap-4 px-4 py-8 animate-in [animation-delay:200ms] [animation-fill-mode:both] md:px-6">
        <p className="flex items-center gap-2.5 text-ui text-muted">
          {!unreached && (
            <span className="flex gap-1" aria-hidden>
              {[0, 1, 2].map((i) => <span key={i} className="size-1.5 rounded-full bg-brass animate-pulse-dot" style={{ animationDelay: `${i * 160}ms` }} />)}
            </span>
          )}
          <span>{unreached ? `${said}. The conversation opens when the connection is back.` : "Loading the conversation"}</span>
        </p>
        {!unreached && (
          <div className="flex flex-col gap-4" aria-hidden>
            <div className="h-11 rounded-sm border-l-[0.1875rem] border-line-strong bg-sunken" />
            <div className="flex flex-col gap-2.5 pt-2">
              <div className={`${line} w-[92%]`} />
              <div className={`${line} w-[78%]`} />
              <div className={`${line} w-[56%]`} />
            </div>
            <div className="h-9 rounded-sm border border-line border-l-[0.1875rem] bg-raised" />
            <div className="flex flex-col gap-2.5">
              <div className={`${line} w-[84%]`} />
              <div className={`${line} w-[40%]`} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
