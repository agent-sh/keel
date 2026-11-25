// The bar at the list's foot while rows are marked (lib/select.ts): what can be done to all of them at once.
// Archive (offered back as one act), Pin, Mark read, Stop, and a message queued into each. The sessions that
// still work are named, so nothing is archived or stopped by surprise. It stands where the list's other foot
// lines stand, so the rows above it never move.
import { Archive, ArchiveRestore, CheckCheck, Pin, PinOff, SendHorizontal, Square, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { announce } from "../lib/announce.ts";
import { auto, stopHere } from "../lib/automation.ts";
import { clearSelection, keepSelected, useSelection } from "../lib/select.ts";
import { archive, archiveMany, pin } from "../lib/sessops.ts";
import { actions, getState, reportError, useStore } from "../lib/store.ts";
import { useSessionStates } from "../lib/watch.ts";
import { STATE_WORD } from "../../../src/core/state-words.ts";

const words = (text: string) => { const t = text.trim().replace(/\s+/g, " "); return t.length > 48 ? `${t.slice(0, 47)}…` : t; };

export function SelectBar() {
  const picked = useSelection();
  const sessions = useStore((x) => x.sessions);
  const list = useMemo(() => [...picked].map((id) => sessions[id]).filter((s) => !!s), [picked, sessions]);
  const states = useSessionStates(list);
  const [text, setText] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);
  // A session that left (deleted) is no longer marked.
  useEffect(() => { keepSelected((id) => !!getState().sessions[id]); }, [sessions]);
  // Escape lets go of the rows, unless a menu or a dialog has it.
  useEffect(() => {
    if (!picked.size) return;
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || document.querySelector('[role="dialog"], [role="menu"]')) return;
      if (text !== null) { setText(null); return; }
      clearSelection();
    };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [picked.size, text]);
  useEffect(() => { if (!picked.size) setText(null); }, [picked.size]);
  useEffect(() => { if (text === "") field.current?.focus(); }, [text]);
  if (!list.length) return null;

  const n = list.length;
  const archived = list.every((s) => s.archived);
  const working = list.filter((s) => states[s.id]?.watch === "work");
  const allPinned = list.every((s) => !!s.settings.pinned_ms);
  const done = (what: string) => { announce(what); clearSelection(); };
  const run = (f: () => Promise<unknown>, what: string) => void f().then(() => done(what), reportError);
  const send = () => {
    const body = (text ?? "").trim();
    if (!body) return;
    // A queued message waits behind what the session is doing: it never steers a turn.
    run(() => Promise.all(list.map((s) => actions.send(s.id, body, { mode: "queue" }))), `Queued for ${n} sessions`);
    setText(null);
  };
  const act = "k-sel-act";
  return (
    <div className="k-sel-bar" data-testid="sel-bar" role="group" aria-label="Selected sessions">
      <div className="k-sel-head">
        <span className="k-sel-count" data-testid="sel-count" aria-live="polite">{n} selected</span>
        <button type="button" className="k-find-btn" data-testid="sel-clear" aria-label="Clear the selection" title="Clear the selection (Esc)" onClick={clearSelection}><X /></button>
      </div>
      {!archived && working.length > 0 && (
        <p className="k-sel-note" data-testid="sel-working" title={working.map((s) => s.title || "New session").join(", ")}>
          {STATE_WORD.work}: {working.map((s) => s.title || "New session").join(", ")}
        </p>
      )}
      {text !== null ? (
        <>
        <form className="k-sel-send" data-testid="sel-send-form" onSubmit={(e) => { e.preventDefault(); send(); }}>
          <input ref={field} className="k-sel-field" data-testid="sel-field" aria-label={`Message queued into each of ${n} sessions`} placeholder="Message to all" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setText(null); } }} />
          <button type="submit" className={act} data-testid="sel-send-go" disabled={!text.trim()} title={text.trim() ? `Queue “${words(text)}” in each of ${n}` : "Write the message first"}>Send to {n}</button>
        </form>
        {/* What goes, and to how many, before it is sent. */}
        {text.trim() && <p className="k-sel-note" data-testid="sel-preview">Queued in each of {n}: “{words(text)}”</p>}
        </>
      ) : archived ? (
        <div className="k-sel-acts">
          <button type="button" className={act} data-testid="sel-restore" onClick={() => run(() => Promise.all(list.map((s) => archive(s, false))), `Restored ${n} sessions`)}><ArchiveRestore />Restore {n}</button>
        </div>
      ) : (
        <div className="k-sel-acts">
          <button type="button" className={act} data-testid="sel-archive" title={working.length ? `Archive ${n}: ${working.map((s) => s.title || "New session").join(", ")} still work${working.length === 1 ? "s" : ""}. It can be undone.` : `Archive ${n} sessions. It can be undone.`} onClick={() => run(() => archiveMany(list), `Archived ${n} sessions`)}><Archive />Archive {n}</button>
          <button type="button" className={act} data-testid="sel-pin" onClick={() => run(() => Promise.all(list.filter((s) => !!s.settings.pinned_ms === allPinned).map((s) => pin(s.id, !allPinned))), allPinned ? "Unpinned" : "Pinned")}>{allPinned ? <PinOff /> : <Pin />}{allPinned ? "Unpin" : "Pin"}</button>
          <button type="button" className={act} data-testid="sel-read" onClick={() => run(() => Promise.all(list.map((s) => auto.read({ session_id: s.id }))), "Marked read")}><CheckCheck />Mark read</button>
          <button type="button" className={act} data-testid="sel-stop" disabled={!working.length} title={working.length ? `Stop ${working.map((s) => s.title || "New session").join(", ")}` : "None of them works"} onClick={() => run(() => Promise.all(working.map((s) => stopHere(s))), `Stop sent to ${working.length}`)}><Square />Stop</button>
          <button type="button" className={act} data-testid="sel-send" title="Queue one message in each" onClick={() => setText("")}><SendHorizontal />Send to all</button>
        </div>
      )}
    </div>
  );
}
