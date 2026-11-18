import { ArrowDown, Brain, Check, ChevronDown, CircleAlert, Copy, Pencil, RotateCcw } from "lucide-react";
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { AssistantBlock, ImageBlock, Session, StoredEvent, ToolResultBlock, ToolUseBlock } from "../../../src/core/types.ts";
import { rowActions } from "../lib/extend.ts";
import { actions, reportError, useStore, type DraftBlock } from "../lib/store.ts";
import { toolKind } from "../lib/tools.ts";
import { getUI, seedComposer, setUI, useUI } from "../lib/ui.ts";
import { cn, fmtTokens } from "../lib/utils.ts";
import { Markdown } from "./Markdown.tsx";
import { ToolCall } from "./ToolCall.tsx";

function Thinking({ text, live }: { text: string; live?: boolean }) {
  if (!text.trim() && !live) return null;
  return (
    <details className="group/think text-ui text-muted" open={live}>
      <summary className="inline-flex cursor-default list-none items-center gap-1.5 rounded-sm py-0.5 pr-1 select-none hover:text-fg">
        <Brain className="size-3.5" />
        <span className={live ? "animate-pulse-dot" : ""}>{live ? "Thinking" : "Thought"}</span>
        {!live && <ChevronDown className="size-3 -rotate-90 transition-transform group-open/think:rotate-0" />}
      </summary>
      {text.trim() && <div className="mt-1.5 max-h-96 overflow-y-auto border-l-2 border-line pl-3.5 text-[14px] leading-relaxed whitespace-pre-wrap">{text}</div>}
    </details>
  );
}

function ActionButton({ label, onClick, children, testid }: { label: string; onClick: () => void; children: ReactNode; testid?: string }) {
  return (
    <button type="button" title={label} aria-label={label} data-testid={testid} onClick={onClick} className="grid size-7 place-items-center rounded-sm text-faint hover:bg-hover hover:text-fg">
      {children}
    </button>
  );
}

function CopyButton({ text, testid }: { text: () => string; testid?: string }) {
  const [done, setDone] = useState(false);
  return (
    <ActionButton
      label={done ? "Copied" : "Copy"}
      testid={testid}
      onClick={() => navigator.clipboard.writeText(text()).then(() => { setDone(true); setTimeout(() => setDone(false), 1400); }, reportError)}
    >
      {done ? <Check className="size-3.5 text-ok" /> : <Copy className="size-3.5" />}
    </ActionButton>
  );
}

function Extra({ on, e, s }: { on: "user" | "assistant"; e: StoredEvent; s: Session }) {
  useSyncExternalStore(rowActions.subscribe, rowActions.version);
  return (
    <>
      {rowActions.all().filter((a) => a.on === on && (!a.when || a.when(e, s))).map((a) => (
        <ActionButton key={a.id} label={a.label} onClick={() => a.run(e, s)}>{a.icon}</ActionButton>
      ))}
    </>
  );
}

function Images({ images }: { images: ImageBlock[] }) {
  const [big, setBig] = useState<number | null>(null);
  return (
    <div className="flex flex-wrap justify-end gap-2">
      {images.map((im, i) => (
        <img
          key={i}
          src={`data:${im.media_type};base64,${im.data}`}
          alt={`Attached image ${i + 1}`}
          onClick={() => setBig(big === i ? null : i)}
          className={cn("rounded-lg border border-line object-cover shadow-1", big === i ? "max-h-[70vh] max-w-full" : "max-h-40 max-w-60")}
        />
      ))}
    </div>
  );
}

function UserMessage({ e, s }: { e: StoredEvent; s: Session }) {
  const text: string = e.data.text ?? "";
  const long = text.length > 1400 || text.split("\n").length > 18;
  const [full, setFull] = useState(false);
  return (
    <div id={`e-${e.id}`} className="group/user row-cv flex scroll-mt-6 flex-col items-end gap-1.5 rounded-lg animate-in" data-testid="user-message">
      {e.data.images?.length > 0 && <Images images={e.data.images} />}
      {text && text !== "(image)" && (
        <div className="relative max-w-[min(85%,40rem)] rounded-xl rounded-br-sm bg-accent-soft px-4 py-2.5 text-read leading-relaxed text-fg">
          <div className={cn("whitespace-pre-wrap break-words", long && !full && "max-h-72 overflow-hidden [mask-image:linear-gradient(to_bottom,black_70%,transparent)]")}>{text}</div>
          {long && (
            <button type="button" onClick={() => setFull(!full)} className="mt-1 text-caption font-medium text-accent-ink hover:underline">
              {full ? "Show less" : "Show all"}
            </button>
          )}
        </div>
      )}
      <div className="-mt-0.5 flex h-6 items-center opacity-0 transition-opacity group-hover/user:opacity-100 focus-within:opacity-100 max-md:opacity-100">
        <CopyButton text={() => text} />
        <ActionButton label="Edit in the message box" onClick={() => seedComposer(text)}><Pencil className="size-3.5" /></ActionButton>
        <Extra on="user" e={e} s={s} />
      </div>
    </div>
  );
}

function AssistantBlocks({ blocks, results, s }: { blocks: AssistantBlock[]; results: Map<string, ToolResultBlock>; s: Session }) {
  return (
    <>
      {blocks.map((b, i) => {
        if (b.type === "text") return b.text.trim() ? <div key={i} data-testid="assistant-text"><Markdown text={b.text} /></div> : null;
        if (b.type === "thinking") return <Thinking key={i} text={b.thinking} />;
        if (b.type === "tool_use") return <ToolCall key={b.id} use={b} result={results.get(b.id)} sessionId={s.id} cwd={s.workspace} waiting={s.phase === "working"} />;
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
        if (b.kind === "text") return b.text.trim() ? <div key={i}><Markdown text={b.text} live /></div> : null;
        if (b.kind === "thinking") return <Thinking key={i} text={b.text} live />;
        let input: any = {};
        try { input = JSON.parse(b.text); } catch {}
        const use: ToolUseBlock = { type: "tool_use", id: `draft-${i}`, name: b.name ?? "tool", input };
        return <ToolCall key={i} use={use} live />;
      })}
    </>
  );
}

function Working({ since }: { since?: number }) {
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, []);
  const s = since ? Math.max(0, Math.round((Date.now() - since) / 1000)) : 0;
  return (
    <div className="flex items-center gap-2.5 py-1 text-ui text-muted" aria-live="polite" data-testid="working">
      <span className="flex gap-1">
        {[0, 1, 2].map((i) => <span key={i} className="size-1.5 rounded-full bg-brass animate-pulse-dot" style={{ animationDelay: `${i * 160}ms` }} />)}
      </span>
      Working{s >= 2 ? <span className="tabular-nums text-faint">{s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`}</span> : null}
    </div>
  );
}

function TurnFooter({ e, reply, prompt, s, last }: { e: StoredEvent; reply: string; prompt?: StoredEvent; s: Session; last: boolean }) {
  const u = e.data.usage;
  const input = u ? u.input + u.cache_read + u.cache_write : 0;
  const cached = u && input ? Math.round((100 * u.cache_read) / input) : 0;
  return (
    <div className={cn("group/foot -mt-1 flex h-7 items-center gap-0.5", !last && "opacity-0 hover:opacity-100 focus-within:opacity-100 max-md:opacity-100")}>
      {reply && <CopyButton text={() => reply} testid="copy-reply" />}
      {prompt && last && s.phase !== "working" && (
        <ActionButton label="Send the prompt again" testid="retry" onClick={() => actions.send(s.id, prompt.data.text, prompt.data.images).catch(reportError)}>
          <RotateCcw className="size-3.5" />
        </ActionButton>
      )}
      <Extra on="assistant" e={e} s={s} />
      <span className="ml-2 flex gap-3 text-micro tabular-nums text-faint select-none" data-testid="turn-end">
        {e.data.reason === "interrupted" && <span className="text-warn">Stopped</span>}
        <span>{(e.data.ms / 1000).toFixed(1)}s</span>
        {u && <span>{fmtTokens(input)} in{cached ? `, ${cached}% cached` : ""}</span>}
        {u && <span>{fmtTokens(u.output)} out</span>}
      </span>
    </div>
  );
}

export function Transcript({ sessionId }: { sessionId: string }) {
  const events = useStore((s) => s.events[sessionId]);
  const draft = useStore((s) => s.drafts[sessionId]);
  const session = useStore((s) => s.sessions[sessionId])!;
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [away, setAway] = useState(false);

  const results = useMemo(() => {
    const m = new Map<string, ToolResultBlock>();
    for (const e of events ?? []) if (e.kind === "tool_result") for (const r of e.data.results) m.set(r.tool_use_id, r);
    return m;
  }, [events]);

  const toEnd = (smooth = false) => {
    const el = scroller.current;
    if (!el) return;
    stick.current = true;
    setAway(false);
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "instant" });
  };

  // Follow the end while it grows (streaming, a tool row opening), unless the reader scrolled up.
  useLayoutEffect(() => { if (stick.current) toEnd(); }, [events, draft]);
  useEffect(() => {
    const c = content.current;
    if (!c) return;
    const ro = new ResizeObserver(() => {
      const el = scroller.current!;
      // The message box keeps the column's edges: it gets the scroll bar's width as padding.
      document.documentElement.style.setProperty("--sbw", `${el.offsetWidth - el.clientWidth}px`);
      if (stick.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(c);
    const onEnd = () => toEnd(true);
    addEventListener("keel:end", onEnd);
    return () => { ro.disconnect(); removeEventListener("keel:end", onEnd); };
  }, [!!events]);

  // A search hit opens the session at its message.
  const focus = useUI((s) => s.focusEvent);
  useEffect(() => {
    if (!focus || !events?.some((e) => e.id === focus)) return;
    stick.current = false;
    requestAnimationFrame(() => {
      const el = document.getElementById(`e-${focus}`);
      if (!el) return;
      el.scrollIntoView({ block: "center" });
      el.classList.add("flash");
      setTimeout(() => el.classList.remove("flash"), 1600);
      if (getUI().focusEvent === focus) setUI({ focusEvent: null });
    });
  }, [focus, events]);

  if (!events) return <div className="flex-1" />;
  const hasDraft = draft && Object.values(draft).some((b) => b.text.trim() || b.kind !== "text");
  const lastStart = [...events].reverse().find((e) => e.kind === "turn_start");
  // A question card waiting on the owner says so itself; no "Working" under it.
  const asking = session.phase === "working" && events.some((e) => e.kind === "assistant" && e.data.blocks.some((b: any) => b.type === "tool_use" && toolKind(b.name) === "ask" && !results.has(b.id)));

  // Per turn: the prompt that started it and the text of its replies, for the footer's actions.
  let prompt: StoredEvent | undefined;
  let reply: string[] = [];
  const lastEnd = [...events].reverse().find((e) => e.kind === "turn_end")?.id;

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scroller}
        className="h-full overflow-y-auto [scrollbar-gutter:stable] [overflow-anchor:none]"
        onScroll={(e) => {
          const el = e.currentTarget;
          const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          stick.current = near;
          if (away === near) setAway(!near);
        }}
      >
        <div ref={content} className="mx-auto flex max-w-[48rem] flex-col gap-4 px-4 py-8 md:px-6" data-testid="transcript">
          {events.length === 0 && session.phase !== "working" && <p className="py-10 text-center text-ui text-faint">No messages yet.</p>}
          {events.map((e) => {
            if (e.kind === "user") {
              prompt = e;
              reply = [];
              return <UserMessage key={e.id} e={e} s={session} />;
            }
            if (e.kind === "assistant") {
              for (const b of e.data.blocks) if (b.type === "text" && b.text.trim()) reply.push(b.text);
              return <div key={e.id} id={`e-${e.id}`} className="row-cv flex flex-col gap-3 rounded-lg"><AssistantBlocks blocks={e.data.blocks} results={results} s={session} /></div>;
            }
            if (e.kind === "error") {
              return (
                <div key={e.id} className="flex items-start gap-2.5 rounded-lg border border-danger/25 bg-danger-soft px-3.5 py-2.5 text-ui text-danger" data-testid="turn-error">
                  <CircleAlert className="mt-0.5 size-4 shrink-0" />
                  <span className="whitespace-pre-wrap break-words">{e.data.message}</span>
                </div>
              );
            }
            if (e.kind === "note") {
              // A note for the model (a background job ended) reads short here: no tags, no log path.
              const text = e.data.model ? String(e.data.text).replace(/<\/?system-reminder>/g, "").replace(/\. Output: \S+/g, ".").trim() : e.data.text;
              return <p key={e.id} className="text-center text-caption text-faint" data-testid="note">{text}</p>;
            }
            if (e.kind === "turn_end") {
              const r = reply.join("\n\n");
              return <Fragment key={e.id}><TurnFooter e={e} reply={r} prompt={prompt} s={session} last={e.id === lastEnd} /></Fragment>;
            }
            return null;
          })}
          {hasDraft && <div className="flex flex-col gap-3"><Draft draft={draft} /></div>}
          {session.phase === "working" && !hasDraft && !asking && <Working since={lastStart?.ts} />}
        </div>
      </div>
      {away && (
        <button
          type="button"
          onClick={() => toEnd(true)}
          data-testid="jump-latest"
          className="absolute bottom-3 left-1/2 flex h-8 -translate-x-1/2 items-center gap-1.5 rounded-full border border-line bg-raised px-3 text-caption font-medium text-muted shadow-2 animate-pop hover:text-fg"
        >
          <ArrowDown className="size-3.5" /> Latest
        </button>
      )}
    </div>
  );
}
