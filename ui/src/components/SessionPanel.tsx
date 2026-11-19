// The session's own marks and operations, as a side-panel tab: pin, done,
// tags, the step budget, messages from other sessions. Plain controls on the
// shared tokens; the look belongs to the design of the workbench.
import { useEffect, useState } from "react";
import type { Session } from "../../../src/core/types.ts";
import { archive, marks, pin, setDone, setMaxSteps, setTags, type Marks } from "../lib/sessops.ts";
import { reportError } from "../lib/store.ts";
import { cn } from "../lib/utils.ts";

export function Section({ title, children, testid }: { title: string; children: React.ReactNode; testid?: string }) {
  return (
    <section className="rounded-lg border border-line bg-raised px-3 py-2" data-testid={testid}>
      <h3 className="pb-1 text-caption font-medium uppercase tracking-wide text-faint">{title}</h3>
      {children}
    </section>
  );
}

export function Line({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 border-b border-line py-2 text-ui last:border-0">
      <span className="min-w-0 flex-1">
        <span className="block">{label}</span>
        {hint && <span className="block text-caption text-faint">{hint}</span>}
      </span>
      {children}
    </div>
  );
}

export function Toggle({ on, label, onChange, testid }: { on: boolean; label: string; onChange: (v: boolean) => void; testid?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      data-testid={testid}
      onClick={() => onChange(!on)}
      className={cn("relative h-5 w-9 shrink-0 rounded-full border border-line-strong transition-colors", on ? "bg-accent" : "bg-sunken")}
    >
      <span className={cn("absolute top-0.5 size-3.5 rounded-full shadow-1 transition-[left]", on ? "left-[18px] bg-accent-fg" : "left-0.5 bg-faint")} />
    </button>
  );
}

export const button = "h-7 shrink-0 rounded-md border border-line-strong px-2.5 text-ui font-medium hover:bg-hover disabled:opacity-50";
export const field = "h-7 min-w-0 rounded-md border border-line bg-sunken px-2 text-ui outline-none focus:ring-2 focus:ring-ring";

function Tags({ s }: { s: Session }) {
  const tags = s.settings.tags ?? [];
  const [text, setText] = useState("");
  const add = () => {
    const t = text.trim();
    if (!t) return;
    setText("");
    setTags(s.id, [...tags, ...t.split(",").map((x) => x.trim()).filter(Boolean)]).catch(reportError);
  };
  return (
    <div className="flex flex-col gap-2 py-2">
      <div className="flex flex-wrap gap-1" data-testid="session-tags">
        {tags.length === 0 && <span className="text-caption text-faint">No tags. Tags group sessions in the list and filter it.</span>}
        {tags.map((t) => (
          <span key={t} className="inline-flex items-center gap-1 rounded-xs bg-sunken px-1.5 py-0.5 text-caption text-muted" data-testid="session-tag">
            {t}
            <button type="button" aria-label={`Remove tag ${t}`} className="text-faint hover:text-fg" onClick={() => setTags(s.id, tags.filter((x) => x !== t)).catch(reportError)}>×</button>
          </span>
        ))}
      </div>
      <div className="flex gap-2">
        <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} placeholder="Add a tag" aria-label="Add a tag" data-testid="tag-input" className={cn(field, "flex-1")} />
        <button type="button" className={button} onClick={add} disabled={!text.trim()}>Add</button>
      </div>
    </div>
  );
}

function Steps({ s }: { s: Session }) {
  const [v, setV] = useState(String(s.settings.max_steps ?? ""));
  useEffect(() => setV(String(s.settings.max_steps ?? "")), [s.settings.max_steps]);
  const save = () => {
    const n = v.trim() === "" ? 0 : Number(v);
    if (!Number.isInteger(n) || n < 0) return setV(String(s.settings.max_steps ?? ""));
    if (n !== (s.settings.max_steps ?? 0)) setMaxSteps(s.id, n).catch(reportError);
  };
  return (
    <input
      value={v}
      inputMode="numeric"
      placeholder="none"
      aria-label="Step budget"
      data-testid="max-steps"
      onChange={(e) => setV(e.target.value.replace(/[^0-9]/g, ""))}
      onBlur={save}
      onKeyDown={(e) => e.key === "Enter" && save()}
      className={cn(field, "w-20 text-right tabular-nums")}
    />
  );
}

function Messages({ s }: { s: Session }) {
  const [m, setM] = useState<Marks | null>(null);
  useEffect(() => { marks.get(s.id).then(setM, reportError); }, [s.id, s.settings.accept_messages, s.settings.peer_turns]);
  const [turns, setTurns] = useState("");
  useEffect(() => { if (m) setTurns(String(m.peer_turns)); }, [m?.peer_turns]);
  if (!m) return null;
  const saveTurns = () => {
    const n = Number(turns);
    if (!Number.isInteger(n) || n < 1) return setTurns(String(m.peer_turns));
    if (n !== m.peer_turns) marks.set(s.id, { peer_turns: n }).then(setM, reportError);
  };
  return (
    <>
      <Line label="Take messages from other sessions" hint="Off: another session's message is refused.">
        <Toggle on={m.accept_messages} label="Take messages from other sessions" testid="accept-messages" onChange={(v) => marks.set(s.id, { accept_messages: v }).then(setM, reportError)} />
      </Line>
      <Line label="Turns they may start" hint="Before you speak here again; past it a message waits for you.">
        <input value={turns} inputMode="numeric" aria-label="Turns other sessions may start" data-testid="peer-turns" disabled={!m.accept_messages}
          onChange={(e) => setTurns(e.target.value.replace(/[^0-9]/g, ""))} onBlur={saveTurns} onKeyDown={(e) => e.key === "Enter" && saveTurns()}
          className={cn(field, "w-20 text-right tabular-nums")} />
      </Line>
    </>
  );
}

// Sections other parts of this lane add (recap, skill mode, folder).
export const extraSections: { id: string; order: number; component: React.ComponentType<{ session: Session }> }[] = [];

export function SessionPanel({ session: s }: { session: Session }) {
  return (
    <div className="flex flex-col gap-3 p-4" data-testid="session-panel">
      <Section title="Marks" testid="marks">
        <Line label="Pinned" hint="Keeps its station on the bridge and the top of the list, on every device.">
          <Toggle on={!!s.settings.pinned_ms} label="Pinned" testid="pin-toggle" onChange={(v) => pin(s.id, v).catch(reportError)} />
        </Line>
        <Line label="Done" hint="The work is finished. Your next message reopens it.">
          <Toggle on={!!s.settings.done_ms} label="Done" testid="done-toggle" onChange={(v) => setDone(s.id, v).catch(reportError)} />
        </Line>
        <Line label="Step budget" hint="Model steps one turn may take. Empty: no budget.">
          <Steps s={s} />
        </Line>
        <Tags s={s} />
      </Section>
      {!s.parent_id && (
        <Section title="Other sessions" testid="peer-marks">
          <Messages s={s} />
        </Section>
      )}
      {[...extraSections].sort((a, b) => a.order - b.order).map((x) => <x.component key={x.id} session={s} />)}
      <Section title="Archive">
        <Line label={s.archived ? "Archived" : "Put it away"} hint={s.archived ? "Restore it to work in it again." : "Stops its turn and background commands; it stays searchable."}>
          <button type="button" className={button} data-testid="panel-archive" onClick={() => archive(s, !s.archived).catch(reportError)}>{s.archived ? "Restore" : "Archive"}</button>
        </Line>
      </Section>
    </div>
  );
}
