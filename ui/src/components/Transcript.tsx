import { ArrowDown, Brain, Check, ChevronDown, ChevronLeft, ChevronRight, CircleAlert, Copy, Layers, Pencil, Play, RotateCcw, ShieldAlert } from "lucide-react";
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { lineage, versions } from "../../../src/core/tree.ts";
import type { AssistantBlock, ImageBlock, Session, StoredEvent, ToolResultBlock, ToolUseBlock } from "../../../src/core/types.ts";
import { rowActions } from "../lib/extend.ts";
import { actions, reportError, useStore, type DraftBlock } from "../lib/store.ts";
import { toolKind } from "../lib/tools.ts";
import { getUI, seedComposer, setUI, useUI } from "../lib/ui.ts";
import { cn, fmtCost, fmtTokens, fmtWait } from "../lib/utils.ts";
import { Markdown } from "./Markdown.tsx";
import { ModelPicker } from "./ModelPicker.tsx";
import { ToolCall } from "./ToolCall.tsx";
import { InputNotice, SYSTEM_INPUT } from "./automation/TranscriptExtras.tsx";

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

// Edit-and-resend makes a new version of the prompt (a sibling in the event
// tree); the arrows move between versions, each its own branch.
function UserMessage({ e, s, all }: { e: StoredEvent; s: Session; all: StoredEvent[] }) {
  const text: string = e.data.text ?? "";
  const long = text.length > 1400 || text.split("\n").length > 18;
  const [full, setFull] = useState(false);
  const [editing, setEditing] = useState(false);
  const vs = useMemo(() => versions(all, e), [all, e]);
  const at = vs.findIndex((v) => v.id === e.id);
  const working = s.phase === "working";
  const origin: string | undefined = e.data.origin;
  const pick = (i: number) => actions.setHead(s.id, vs[i]!.id).catch(reportError);
  if (editing) return <EditPrompt e={e} s={s} onDone={() => setEditing(false)} />;
  return (
    <div id={`e-${e.id}`} className="group/user row-cv flex scroll-mt-6 flex-col items-end gap-1.5 rounded-lg animate-in" data-testid="user-message" data-event-id={e.id}>
      {origin === "steer" && <span className="text-micro font-medium text-faint" data-testid="origin-steer">Steered into the turn</span>}
      {origin === "queued" && <span className="text-micro font-medium text-faint" data-testid="origin-queued">From the queue</span>}
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
      <div className="-mt-0.5 flex h-6 items-center">
        <span className="flex items-center opacity-0 transition-opacity group-hover/user:opacity-100 focus-within:opacity-100 max-md:opacity-100">
          <CopyButton text={() => text} />
          <ActionButton label="Edit and send as a new version" testid="edit-message" onClick={() => setEditing(true)}><Pencil className="size-3.5" /></ActionButton>
          <Extra on="user" e={e} s={s} />
        </span>
        {vs.length > 1 && (
          <span className="flex items-center text-caption tabular-nums text-faint" data-testid="branch-nav">
            <button type="button" aria-label="Previous version" title="Previous version" disabled={at <= 0 || working} onClick={() => pick(at - 1)} className="grid size-7 place-items-center rounded-sm hover:bg-hover hover:text-fg disabled:opacity-40">
              <ChevronLeft className="size-3.5" />
            </button>
            <span data-testid="branch-pos">{at + 1}/{vs.length}</span>
            <button type="button" aria-label="Next version" title="Next version" disabled={at >= vs.length - 1 || working} onClick={() => pick(at + 1)} className="grid size-7 place-items-center rounded-sm hover:bg-hover hover:text-fg disabled:opacity-40">
              <ChevronRight className="size-3.5" />
            </button>
          </span>
        )}
      </div>
    </div>
  );
}

function EditPrompt({ e, s, onDone }: { e: StoredEvent; s: Session; onDone: () => void }) {
  const [text, setText] = useState<string>(e.data.text ?? "");
  const send = () => text.trim() && actions.edit(s.id, e.id, text.trim()).then(onDone, reportError);
  return (
    <div className="flex justify-end animate-in" data-event-id={e.id}>
      <div className="w-[min(85%,40rem)] rounded-xl border border-line-strong bg-raised p-2 shadow-2">
        <textarea
          data-testid="edit-box"
          autoFocus
          value={text}
          aria-label="Edit the prompt"
          onChange={(x) => setText(x.target.value)}
          onKeyDown={(x) => {
            if (x.key === "Escape") onDone();
            if (x.key === "Enter" && !x.shiftKey) { x.preventDefault(); send(); }
          }}
          className="block min-h-16 w-full resize-y bg-transparent px-2 py-1 text-read leading-relaxed outline-none"
        />
        <div className="flex items-center justify-end gap-1.5 pt-1">
          <span className="mr-auto pl-2 text-caption text-faint">{s.phase === "working" ? "Stops the turn, then sends this as a new version." : "Sends as a new version; the current one stays as a branch."}</span>
          <button type="button" onClick={onDone} className="h-7 rounded-md px-2.5 text-ui text-muted hover:bg-hover">Cancel</button>
          <button type="button" data-testid="edit-send" disabled={!text.trim()} onClick={send} className="h-7 rounded-md bg-accent px-2.5 text-ui font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-40">
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

// A declined reply: what the provider said, and a way on with another model.
function Refusal({ e, s }: { e: StoredEvent; s: Session }) {
  const [pick, setPick] = useState("");
  const d = e.data.stop_details ?? {};
  return (
    <div className="rounded-lg border border-warn/40 bg-raised px-3.5 py-3 text-ui" data-testid="refusal">
      <div className="flex items-center gap-2 font-medium">
        <ShieldAlert className="size-4 text-warn" /> The model declined this request
        {d.category && <span className="rounded-sm bg-sunken px-1.5 py-px text-micro uppercase tracking-wide text-muted">{d.category}</span>}
      </div>
      {d.explanation && <p className="mt-1 text-muted">{d.explanation}</p>}
      <p className="mt-1 text-muted">Its partial reply is left out of the context. Another model can take the same request.</p>
      <div className="mt-2 flex items-center gap-2">
        <div className="rounded-md border border-line"><ModelPicker value={pick || s.model} onChange={setPick} /></div>
        <button
          type="button"
          disabled={!pick || pick === s.model}
          onClick={() => actions.patch(s.id, { model: pick }).then(() => actions.resume(s.id)).catch(reportError)}
          className="h-8 rounded-md bg-accent px-3 font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-40"
        >
          Retry on it
        </button>
      </div>
    </div>
  );
}

function Divider({ children, testid }: { children: ReactNode; testid?: string }) {
  return (
    <div className="flex items-center gap-3 py-1 text-caption text-faint" data-testid={testid}>
      <span className="h-px flex-1 bg-line" />
      {children}
      <span className="h-px flex-1 bg-line" />
    </div>
  );
}

// A context checkpoint: a summary (expandable) or a clear (undo while it is the head).
function Checkpoint({ e, s }: { e: StoredEvent; s: Session }) {
  if (e.data.mode === "clear") {
    return (
      <Divider testid="cleared">
        <span className="flex items-center gap-1.5"><RotateCcw className="size-3.5" /> Context cleared. The model starts fresh from here.</span>
        {e.id === s.head && (
          <button type="button" className="rounded-sm px-1.5 py-0.5 font-medium text-accent-ink hover:bg-accent-soft" onClick={() => actions.setHead(s.id, e.data.undo_head, false, false).catch(reportError)}>
            Undo
          </button>
        )}
      </Divider>
    );
  }
  return (
    <details className="group/cp" data-testid="compacted">
      <summary className="list-none cursor-default">
        <Divider>
          <span className="flex items-center gap-1.5 hover:text-fg">
            <Layers className="size-3.5" />
            {e.data.auto ? "Context compacted automatically" : "Context compacted"}
            {e.data.tokens_before ? `, ${fmtTokens(e.data.tokens_before)} tokens into a summary` : ""}
            <ChevronDown className="size-3 -rotate-90 transition-transform group-open/cp:rotate-0" />
          </span>
        </Divider>
      </summary>
      <div className="mt-2 rounded-lg border border-line bg-raised px-4 py-3 text-ui text-muted"><Markdown text={e.data.summary} /></div>
    </details>
  );
}

// Live, not stored: a retry wait or a compaction in progress.
function Status({ sessionId }: { sessionId: string }) {
  const st = useStore((x) => x.status[sessionId]);
  const [, tick] = useState(0);
  useEffect(() => {
    if (st?.kind !== "retry") return;
    const t = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, [st]);
  if (!st || st.kind === "idle") return null;
  if (st.kind === "compacting") {
    return <div className="flex items-center gap-2 text-ui text-muted animate-pulse-dot" data-testid="compacting"><Layers className="size-3.5" /> Compacting the context</div>;
  }
  return (
    <div className="flex items-center gap-2 rounded-lg border border-warn/40 bg-raised px-3 py-2 text-ui" data-testid="retrying">
      <span className="size-1.5 rounded-full bg-warn animate-pulse-dot" />
      <span className="min-w-0 flex-1 truncate text-muted" title={st.message}>{st.message}</span>
      <span className="shrink-0 tabular-nums text-faint">retrying in {fmtWait(st.at - Date.now())}, attempt {st.attempt} of {st.max}</span>
    </div>
  );
}

function AssistantBlocks({ blocks, results, s }: { blocks: AssistantBlock[]; results: Map<string, ToolResultBlock>; s: Session }) {
  return (
    <>
      {blocks.map((b, i) => {
        if (b.type === "text") return b.text.trim() ? <div key={i} data-testid="assistant-text"><Markdown text={b.text} /></div> : null;
        // A thought may carry only opaque state for replay (an encrypted item): nothing to show.
        if (b.type === "thinking") return b.thinking.trim() ? <Thinking key={i} text={b.thinking} /> : null;
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

const REASONS: Record<string, string> = { interrupted: "Stopped", max_tokens: "Cut at the output limit", refusal: "Declined", error: "Failed" };

function TurnFooter({ e, reply, prompt, s, last }: { e: StoredEvent; reply: string; prompt?: StoredEvent; s: Session; last: boolean }) {
  const u = e.data.usage;
  const input = u ? u.input + u.cache_read + u.cache_write : 0;
  const cached = u && input ? Math.round((100 * u.cache_read) / input) : 0;
  return (
    <div className={cn("group/foot -mt-1 flex h-7 items-center gap-0.5", !last && "opacity-0 hover:opacity-100 focus-within:opacity-100 max-md:opacity-100")}>
      {reply && <CopyButton text={() => reply} testid="copy-reply" />}
      {prompt && last && s.phase !== "working" && (
        <ActionButton label="Answer again (a new version; this one stays a branch)" testid="retry" onClick={() => actions.edit(s.id, prompt.id, prompt.data.text).catch(reportError)}>
          <RotateCcw className="size-3.5" />
        </ActionButton>
      )}
      <Extra on="assistant" e={e} s={s} />
      <span className="ml-2 flex gap-3 text-micro tabular-nums text-faint select-none" data-testid="turn-end">
        {REASONS[e.data.reason] && <span className="text-warn">{REASONS[e.data.reason]}</span>}
        <span>{(e.data.ms / 1000).toFixed(1)}s</span>
        {u && <span>{fmtTokens(input)} in{cached ? `, ${cached}% cached` : ""}</span>}
        {u && <span>{fmtTokens(u.output)} out</span>}
        {u?.cost !== undefined && !u.unpriced ? <span data-testid="turn-cost">${u.cost < 0.01 ? u.cost.toFixed(4) : u.cost.toFixed(2)}</span> : u?.unpriced ? <span>cost unknown</span> : null}
      </span>
      {last && s.phase !== "working" && REASONS[e.data.reason] && (
        <button type="button" data-testid="resume" onClick={() => actions.resume(s.id).catch(reportError)} className="ml-2 flex h-6 items-center gap-1 rounded-sm px-1.5 text-caption font-medium text-accent-ink hover:bg-accent-soft">
          <Play className="size-3" /> Continue
        </button>
      )}
    </div>
  );
}

export function Transcript({ sessionId }: { sessionId: string }) {
  const all = useStore((s) => s.events[sessionId]);
  const draft = useStore((s) => s.drafts[sessionId]);
  const session = useStore((s) => s.sessions[sessionId])!;
  const events = useMemo(() => (all ? lineage(all, session.head) : undefined), [all, session.head]);
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
              if (e.data.origin === "harness") {
                return <p key={e.id} className="text-center text-caption text-faint" data-testid="harness-note">{String(e.data.text).replace(/^\[harness\]\s*/, "")}</p>;
              }
              prompt = e;
              reply = [];
              return SYSTEM_INPUT.has(e.data.kind) ? <InputNotice key={e.id} e={e} /> : <UserMessage key={e.id} e={e} s={session} all={all!} />;
            }
            if (e.kind === "compaction") return <Checkpoint key={e.id} e={e} s={session} />;
            if (e.kind === "assistant" && e.data.stop === "refusal") return <Refusal key={e.id} e={e} s={session} />;
            if (e.kind === "assistant") {
              for (const b of e.data.blocks) if (b.type === "text" && b.text.trim()) reply.push(b.text);
              return <div key={e.id} id={`e-${e.id}`} className="row-cv flex flex-col gap-3 rounded-lg" data-event-id={e.id}><AssistantBlocks blocks={e.data.blocks} results={results} s={session} /></div>;
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
              const text = e.data.skill ? `Loaded the ${e.data.skill} skill` : e.data.model ? String(e.data.text).replace(/<\/?system-reminder>/g, "").replace(/\. Output: \S+/g, ".").trim() : e.data.text;
              return <Divider key={e.id} testid="note"><span>{text}</span></Divider>;
            }
            if (e.kind === "turn_end") {
              const r = reply.join("\n\n");
              return <Fragment key={e.id}><TurnFooter e={e} reply={r} prompt={prompt} s={session} last={e.id === lastEnd} /></Fragment>;
            }
            return null;
          })}
          {hasDraft && <div className="flex flex-col gap-3"><Draft draft={draft} /></div>}
          <Status sessionId={sessionId} />
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
