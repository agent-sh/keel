import { Brain, CircleAlert } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import type { AssistantBlock, StoredEvent, ToolResultBlock, ToolUseBlock } from "../../../src/core/types.ts";
import { useStore, type DraftBlock } from "../lib/store.ts";
import { fmtTokens } from "../lib/utils.ts";
import { Markdown } from "./Markdown.tsx";
import { ToolCall } from "./ToolCall.tsx";

function Thinking({ text, live }: { text: string; live?: boolean }) {
  if (!text.trim() && !live) return null;
  return (
    <details className="group text-[13px] text-muted" open={live}>
      <summary className="flex cursor-pointer list-none items-center gap-1.5 select-none hover:text-fg">
        <Brain className="size-3.5" />
        <span className={live ? "animate-pulse-dot" : ""}>{live ? "Thinking" : "Thought"}</span>
      </summary>
      {text.trim() && <div className="mt-1.5 border-l-2 border-line pl-3 whitespace-pre-wrap leading-relaxed">{text}</div>}
    </details>
  );
}

function UserBubble({ e }: { e: StoredEvent }) {
  return (
    <div className="flex justify-end animate-in" data-testid="user-message">
      <div className="max-w-[85%] rounded-2xl rounded-br-md bg-accent-soft px-4 py-2.5 whitespace-pre-wrap leading-relaxed">{e.data.text}</div>
    </div>
  );
}

function AssistantBlocks({ blocks, results }: { blocks: AssistantBlock[]; results: Map<string, ToolResultBlock> }) {
  return (
    <>
      {blocks.map((b, i) => {
        if (b.type === "text") return b.text.trim() ? <div key={i} data-testid="assistant-text"><Markdown text={b.text} /></div> : null;
        if (b.type === "thinking") return <Thinking key={i} text={b.thinking} />;
        if (b.type === "tool_use") return <ToolCall key={i} use={b} result={results.get(b.id)} />;
        return null;
      })}
    </>
  );
}

function Draft({ draft }: { draft: Record<number, DraftBlock> }) {
  const blocks = Object.entries(draft).sort(([a], [b]) => Number(a) - Number(b));
  return (
    <>
      {blocks.map(([i, b]) => {
        if (b.kind === "text") return <div key={i}><Markdown text={b.text} /></div>;
        if (b.kind === "thinking") return <Thinking key={i} text={b.text} live />;
        let input: any = {};
        try { input = JSON.parse(b.text); } catch {}
        const use: ToolUseBlock = { type: "tool_use", id: `draft-${i}`, name: b.name ?? "tool", input };
        return <ToolCall key={i} use={use} live />;
      })}
    </>
  );
}

export function Transcript({ sessionId }: { sessionId: string }) {
  const events = useStore((s) => s.events[sessionId]);
  const draft = useStore((s) => s.drafts[sessionId]);
  const phase = useStore((s) => s.sessions[sessionId]?.phase);
  const bottom = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const results = useMemo(() => {
    const m = new Map<string, ToolResultBlock>();
    for (const e of events ?? []) if (e.kind === "tool_result") for (const r of e.data.results) m.set(r.tool_use_id, r);
    return m;
  }, [events]);

  useEffect(() => {
    if (stick.current) bottom.current?.scrollIntoView({ block: "end" });
  }, [events, draft]);

  if (!events) return <div className="flex-1" />;
  const hasDraft = draft && Object.keys(draft).length > 0;

  return (
    <div
      ref={scroller}
      className="flex-1 overflow-y-auto"
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
    >
      <div className="mx-auto flex max-w-3xl flex-col gap-4 px-5 py-8" data-testid="transcript">
        {events.map((e) => {
          if (e.kind === "user") return <UserBubble key={e.id} e={e} />;
          if (e.kind === "assistant") return <div key={e.id} className="flex flex-col gap-3"><AssistantBlocks blocks={e.data.blocks} results={results} /></div>;
          if (e.kind === "error") {
            return (
              <div key={e.id} className="flex items-start gap-2 rounded-xl border border-danger/30 bg-danger-soft px-3.5 py-2.5 text-[13px] text-danger" data-testid="turn-error">
                <CircleAlert className="mt-0.5 size-4 shrink-0" />
                <span className="whitespace-pre-wrap break-words">{e.data.message}</span>
              </div>
            );
          }
          if (e.kind === "turn_end" && e.data.usage) {
            const u = e.data.usage;
            return (
              <div key={e.id} className="text-[11.5px] text-faint tabular-nums select-none" data-testid="turn-end">
                {e.data.reason === "interrupted" ? "Stopped · " : ""}
                {(e.data.ms / 1000).toFixed(1)}s · {fmtTokens(u.input + u.cache_read + u.cache_write)} in
                {u.cache_read ? ` (${Math.round((100 * u.cache_read) / (u.input + u.cache_read + u.cache_write))}% cached)` : ""} · {fmtTokens(u.output)} out
              </div>
            );
          }
          return null;
        })}
        {hasDraft && <div className="flex flex-col gap-3"><Draft draft={draft} /></div>}
        {phase === "working" && !hasDraft && (
          <div className="flex gap-1 py-1" aria-label="Working">
            {[0, 1, 2].map((i) => (
              <span key={i} className="size-1.5 rounded-full bg-faint animate-pulse-dot" style={{ animationDelay: `${i * 160}ms` }} />
            ))}
          </div>
        )}
        <div ref={bottom} />
      </div>
    </div>
  );
}
