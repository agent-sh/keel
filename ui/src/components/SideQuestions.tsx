// Side questions (/btw) in the side panel: asked from the conversation as it
// stands, answered without tools, never added to it. Follow-ups continue the
// thread; a new thread starts clean.
import { CornerDownLeft, Plus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Session } from "../../../src/core/types.ts";
import { composing } from "../lib/keys.ts";
import { news } from "../lib/news.ts";
import { boxOf } from "../lib/quote.ts";
import { reportError } from "../lib/store.ts";
import { side, type SideState } from "../lib/side.ts";
import { cn, fmtCost, fmtTokens } from "../lib/utils.ts";
import { Markdown } from "./Markdown.tsx";

const use = <T,>(sel: (s: SideState) => T) => useSyncExternalStore(side.subscribe, () => sel(side.state()));

export function SideQuestions({ session }: { session: Session }) {
  const threads = use((s) => s.threads[session.id]);
  const pending = use((s) => s.pending[session.id]);
  const current = use((s) => s.current[session.id]);
  const error = use((s) => s.error[session.id]);
  const failedQ = use((s) => s.failed[session.id]);
  const branched = use((s) => s.branched[session.id]);
  const [text, setText] = useState("");
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { if (!threads) side.load(session.id).catch(reportError); }, [session.id]);
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [threads, pending]);
  // Shown, so seen: what landed while it was not is read now.
  useEffect(() => { news.clear(session.id, "side"); }, [session.id, threads]);
  const ask = () => {
    const q = text.trim();
    if (!q) return;
    setText("");
    side.ask(session.id, q).catch(reportError); // asked while one is answered: it waits its turn
  };
  const shown = threads ?? [];
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="side-questions">
      <div className="flex items-start gap-2 border-b border-line px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="text-ui font-medium">Side questions</p>
          <p className="text-caption text-muted">Answered from this conversation with no tools. Nothing here enters it.</p>
        </div>
        <button type="button" onClick={() => side.newThread(session.id)} title="Start a new thread" className="flex h-7 items-center gap-1 rounded-md px-2 text-caption text-muted hover:bg-hover hover:text-fg">
          <Plus className="size-3.5" /> New thread
        </button>
        <button type="button" data-testid="side-clear" onClick={() => side.clear(session.id).catch(reportError)} disabled={!shown.length} title="Forget every side question of this session" className="grid size-7 place-items-center rounded-md text-faint hover:bg-hover hover:text-danger disabled:opacity-40">
          <Trash2 className="size-3.5" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {!shown.length && !pending && (
          <div className="k-empty py-4">
            <b>No side question yet</b>
            <p>Ask about what this session already knows: a file it read, a decision it made.</p>
            <p>Type <span className="font-mono text-muted">/btw</span> and a question in the message box, or ask below.</p>
          </div>
        )}
        {shown.map((t) => (
          <section key={t.id} className={cn("flex flex-col gap-4 pb-5", t.id !== current && "opacity-60")} data-testid="side-thread">
            {t.id !== shown[0]!.id && <div className="h-px bg-line" />}
            {t.exchanges.map((x) => (
              <div key={x.id} className="flex flex-col gap-2" data-testid="side-exchange">
                <div className="self-end max-w-[85%] rounded-xl rounded-br-sm bg-accent-soft px-3.5 py-2 text-ui whitespace-pre-wrap">{x.question}</div>
                <div className="text-ui" data-testid="side-answer"><Markdown text={x.answer} /></div>
                <div className="flex">
                  <button type="button" data-testid="side-put" onClick={() => boxOf(session.id)?.quote(x.answer)} title="Put this answer, quoted, in the message box" className="flex h-6 items-center gap-1 rounded-md px-1.5 text-micro text-muted hover:bg-hover hover:text-fg">
                    <CornerDownLeft className="size-3" /> Put in message
                  </button>
                </div>
                <p className="text-micro tabular-nums text-faint">
                  {fmtTokens(x.usage.input + x.usage.cache_read + x.usage.cache_write)} in
                  {x.usage.cache_read ? `, ${Math.round((100 * x.usage.cache_read) / (x.usage.input + x.usage.cache_read + x.usage.cache_write))}% cached` : ""}
                  {x.usage.cost !== undefined ? ` · ${fmtCost(x.usage.cost)}` : ""}
                </p>
              </div>
            ))}
          </section>
        ))}
        {branched && <p className="pb-3 text-caption text-faint" data-testid="side-branched">The conversation is on another branch now, so this started a new thread. The earlier one stays above.</p>}
        {pending?.map((q, i) => (
          <div key={`${i}:${q}`} className="flex flex-col gap-2 pb-4" data-testid="side-pending">
            <div className="self-end max-w-[85%] rounded-xl rounded-br-sm bg-accent-soft px-3.5 py-2 text-ui whitespace-pre-wrap">{q}</div>
            <p className={cn("text-ui text-muted", i === 0 && "animate-pulse-dot")}>{i === 0 ? "Answering" : "Waits for the answer before it"}</p>
          </div>
        ))}
        {failedQ && (
          <div className="flex flex-col gap-2" data-testid="side-failed">
            <div className="self-end max-w-[85%] rounded-xl rounded-br-sm border border-danger/30 px-3.5 py-2 text-ui whitespace-pre-wrap text-muted">{failedQ}</div>
            <div className="flex items-center gap-2 self-end text-caption">
              <span className="text-danger">{error ? `Not answered: ${error}` : "Not answered."}</span>
              <button type="button" data-testid="side-retry" onClick={() => side.ask(session.id, failedQ).catch(reportError)} className="h-7 rounded-md px-2 font-medium text-accent-ink hover:bg-accent-soft">Retry</button>
              <button type="button" data-testid="side-edit" onClick={() => { if (!text.trim()) setText(failedQ); side.dismissFailed(session.id); }} className="h-7 rounded-md px-2 text-muted hover:bg-hover hover:text-fg">Edit</button>
            </div>
          </div>
        )}
        {error && !failedQ && <p className="text-caption text-danger">{error}</p>}
        <div ref={end} />
      </div>
      <div className="border-t border-line p-3">
        <textarea
          data-testid="side-input"
          value={text}
          rows={2}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (composing(e)) return; // the Enter that confirms a composed word is the input method's
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(); }
          }}
          placeholder={current ? "Ask a follow-up" : "Ask a side question"}
          className="k-field h-auto block w-full resize-none py-2"
        />
      </div>
    </div>
  );
}
