// A session another harness runs, in the composer's place: Keel shows what it
// writes, its state from its own records, what it spent, the files its calls
// changed and who holds it now. A Codex or Claude Code session nothing else
// holds is answered here: the text goes to that same session in its harness
// (src/integrations/outside/codex-app.ts, claude-code.ts), the reply comes into
// this view as the harness writes it, and what it asks comes as Keel's cards
// above. A terminal that has it open is answered through it: the agent view types the text there
// (src/integrations/outside/terminal.ts), held while the owner's unsent draft is in its box or the box cannot be read, and the reply
// comes here from the transcript. Who holds it and what a send does are the box's placeholder; while
// any other process holds it, the bar says who and offers nothing that writes.
// A copy that goes on here is the row menu's Fork into Keel, the exception.
// A session that moved here from Keel (src/server/routes/continue.ts) says so.
import { ArrowUp, ChevronDown, ChevronRight, Square, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Holder, Session, Usage } from "../../../src/core/types.ts";
import { shortPath } from "../../../src/core/tool-line.ts";
import { OUTSIDE_LABEL } from "../../../src/core/watch.ts";
import { holderSaid } from "../../../src/core/holder-words.ts";
import { api, failed, onFeature, reportUnlessGone } from "../lib/store.ts";
import { composing } from "../lib/keys.ts";
import { usePhoneWidth } from "../lib/list-hold.ts";
import { navigate } from "../lib/ui.ts";
import { clock, fmtSessionCost, fmtTokens } from "../lib/utils.ts";
import { useSessionState } from "../lib/watch.ts";
import { setAnswers, type Answered } from "../lib/outside-answers.ts";
import { Mark } from "./Mark.tsx";

type Send = { id: string; text: string; state: "stored" | "started" | "delivered" | "lost" | "failed" | "cut"; said: string | null };
type Route = "resume" | "steer" | "terminal" | "held" | "missing" | "unlocked" | "none";
type Details = {
  harness: string; label: string; source_id: string; path: string; live: boolean; files: string[]; usage: { model: string; usage: Usage; cost: number | null }[];
  holder?: Holder; route?: Route; turn?: boolean; sends?: Send[]; notes?: string[]; answers?: Record<string, Answered>;
  moved_from?: { id: string; title: string };
};

const tokensOf = (u: Usage) => u.input + u.output + u.cache_read + u.cache_write;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

export function OutsideBar({ session }: { session: Session }) {
  const o = session.outside!;
  const where = OUTSIDE_LABEL[o.harness] ?? o.harness;
  const st = useSessionState(session);
  const [d, setD] = useState<Details | null>(null);
  const [files, setFiles] = useState(false);
  const [note, setNote] = useState("");
  // What became of the last text typed into a terminal (typed, or waiting there until the session is ready).
  const [typed, setTyped] = useState("");
  const [text, setText] = useState("");
  // The draft's own key: a draft sent twice (a double press, Send again after a failure) is stored once.
  const draftKey = useRef<string>(crypto.randomUUID());
  const textNow = useRef(text);
  textNow.current = text;
  const [sends, setSends] = useState<Send[] | null>(null);
  // What the driver says of the last turn besides its sends (a form it declined).
  const [notes, setNotes] = useState<string[]>([]);
  const holder = o.holder ?? d?.holder;
  // Read when the bar shows and again when what it shows changed (a file more, the state, who holds it): the transcript catches up first.
  useEffect(() => {
    let live = true;
    api<Details>(`/api/sessions/${session.id}/outside`).then((r) => { if (live) { setD(r); setSends(r.sends ?? []); setNotes(r.notes ?? []); setAnswers(session.id, r.answers); } }, (e) => reportUnlessGone(e, { at: "OutsideBar" }));
    return () => { live = false; };
  }, [session.id, o.files, o.state, o.failures, o.holder?.kind, o.holder?.pid]);
  // The sends not yet in the transcript, as they change.
  useEffect(() => onFeature({ frame: (f) => {
    if (f.name !== "outside_sends" || f.session_id !== session.id) return;
    const data = f.data as { sends?: Send[]; notes?: string[]; answers?: Record<string, Answered> } | undefined;
    setSends(data?.sends ?? []);
    setNotes(data?.notes ?? []);
    if (data?.answers) setAnswers(session.id, data.answers);
  } }), [session.id]);
  // What a send does now, from who holds it: Keel resumes it, adds to the turn Keel runs, or nothing.
  const route: Route = d?.route === "none" ? "none" : holder?.kind === "keel" ? "steer" : holder?.kind === "terminal" && d?.route === "terminal" ? "terminal" : holder && holder.kind !== "free" ? "held" : d?.route === "missing" || d?.route === "unlocked" ? d.route : "resume";
  const program = o.harness === "claude" ? "claude" : "codex";
  const send = async (words: string, again?: string) => {
    if (!words.trim()) return;
    setNote("");
    setTyped("");
    const key = again ? `again-${again}` : draftKey.current;
    // The box is cleared before the request goes, and the next draft gets a key of its own.
    if (!again) { setText(""); draftKey.current = crypto.randomUUID(); }
    try {
      const r = await api<{ sent?: { said: string } }>(`/api/sessions/${session.id}/outside/send`, { method: "POST", body: JSON.stringify({ text: words, client_id: key, ...(again ? { again } : {}) }) });
      if (r?.sent) setTyped(r.sent.said);
    } catch (e) {
      // Not taken: the draft comes back with its key, unless a new one was typed since.
      if (!again && !textNow.current) { setText(words); draftKey.current = key; }
      setNote(failed(e, { at: "OutsideBar send" }));
    }
  };
  // One Stop at a time: a press while its request is out is the same Stop (a second one, later, ends the child).
  const [stopping, setStopping] = useState(false);
  const stop = async () => {
    if (stopping) return;
    setStopping(true);
    try { await api(`/api/sessions/${session.id}/outside/interrupt`, { method: "POST" }); }
    catch (e) { setNote(failed(e, { at: "OutsideBar stop" })); }
    finally { setStopping(false); }
  };
  const dismiss = (id: string) => api(`/api/sessions/${session.id}/outside/sends/${id}`, { method: "DELETE" }).catch((e) => setNote(failed(e, { at: "OutsideBar dismiss" })));
  // Stale: it worked or waited and has written nothing since (no process vouches for it): said as that, in no state's colour.
  // A card of Codex's waits on the owner above: that is what the session waits for now, whatever its record says.
  const above = st.watch === "need" && o.state !== "waiting";
  const said = above ? `Waits for your answer: ${where} asks above` : o.state === "waiting" ? `Waits in ${where} for ${o.waiting_for ?? "your answer"}` : o.state === "working" ? `Working in ${where}` : o.state === "stale" ? `No record from ${where}` : `Done in ${where}`;
  const u = session.usage;
  const cost = typeof u.cost === "number" && !u.unpriced ? fmtSessionCost(u.cost) : typeof u.cost === "number" && u.cost > 0 ? `${fmtSessionCost(u.cost)} and more unpriced` : "";
  const spent = [o.model, tokensOf(u) ? `${fmtTokens(tokensOf(u))} tokens` : "", cost].filter(Boolean).join(" · ");
  const answering = route === "resume" || route === "steer" || route === "terminal";
  const pending = (sends ?? []).filter((x) => x.state !== "delivered");
  // Who holds it and what a send does, in the box itself.
  const placeholder = route === "steer" ? `${holderSaid(holder, where)}: what you send joins the turn it runs in ${where}` : route === "terminal" ? `${holderSaid(holder, where)}: Keel types what you send into that terminal` : `${holderSaid(holder, where)}: what you send resumes this session in ${where}`;
  // A phone's line holds a few words: what the field does, said whole (the sentence stays its label).
  const narrow = usePhoneWidth();
  const shown = !narrow ? placeholder : route === "steer" ? "Add to the turn" : route === "terminal" ? "Type into its terminal" : `Answer in ${where}`;
  const quiet = route === "held" ? `${holderSaid(holder, where)}: answer it there. Keel sends nothing while another process holds it.`
    : route === "missing" ? `No ${program} program here: Keel answers a ${where} session with the ${program} on your PATH.`
    : route === "unlocked" ? `This ${where} keeps no writer locks, so Keel cannot tell whether a terminal has it open: answer it there, or update ${where}.`
    : route === "terminal" ? `Typed into that terminal, the same session there: its reply comes here. Held while your unsent draft is in its box, or Keel cannot read the box.`
    : route === "none" ? `${where} holds this session: Keel shows what it writes and sends nothing to it. Fork into Keel, in the row's menu, makes a session here with its own history.`
    : `Sent to this same session in ${where}: its reply comes here, and what it asks comes as cards.`;
  return (
    <section className="k-outside" data-testid="outside-bar" data-holder={route === "none" ? undefined : holder?.kind ?? "free"} data-state={st.watch === "need" ? "waiting" : o.state} data-harness={o.harness} data-answering={answering ? "" : undefined} data-route={route} data-above={above ? "" : undefined} aria-label={`${where} session`}>
      <div className="k-outside-head">
        <Mark w={st.watch} />
        <div className="min-w-0 flex-1">
          <p className="k-outside-state" data-testid="outside-state">
            {said}
            {o.since > 0 && <span className="k-outside-since" title={`Since ${clock(o.since, { seconds: true })}`}> since {clock(o.since)}</span>}
          </p>
          <p className="k-outside-facts" data-testid="outside-facts">
            {/* Who holds it is the box's placeholder; held by another process (no box), it is said here. */}
            {(route === "held" || route === "terminal") && <span className="k-outside-holder" data-testid="outside-holder" data-kind={holder?.kind ?? "free"}>{holderSaid(holder, where)}</span>}
            {spent && <span data-testid="outside-spent">{spent}</span>}
            {o.files > 0 && (
              <button type="button" className="k-outside-files-btn" aria-expanded={files} data-testid="outside-files-toggle" onClick={() => setFiles((x) => !x)}>
                {files ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}{plural(o.files, "file")} changed
              </button>
            )}
            {o.failures > 0 && <span className="k-outside-failed" data-testid="outside-failures">{plural(o.failures, "failed call")}</span>}
          </p>
        </div>
      </div>
      {d?.moved_from && (
        <p className="k-outside-note k-outside-from" data-testid="outside-moved-from">
          Moved here from Keel: <a href={`/s/${d.moved_from.id}`} onClick={(e) => { e.preventDefault(); navigate({ name: "session", id: d.moved_from!.id }); }}>{d.moved_from.title || "a session"}</a>, archived there.
        </p>
      )}
      {files && d && (
        <ul className="k-outside-files" data-testid="outside-files">
          {d.files.map((f) => <li key={f} title={f}>{shortPath(f, session.workspace)}</li>)}
        </ul>
      )}
      {pending.length > 0 && (
        <ul className="k-outside-sends" data-testid="outside-sends">
          {pending.map((x) => (
            <li key={x.id} className="k-outside-send" data-state={x.state} data-testid="outside-send-row">
              <span className="k-outside-send-text" title={x.text}>{x.text}</span>
              <span className="k-outside-send-said">{x.state === "stored" ? `Going to ${where}` : x.state === "started" ? `Given to ${where}` : x.said ?? "Not delivered"}</span>
              {(x.state === "lost" || x.state === "failed" || x.state === "cut") && (
                <>
                  {answering && x.state !== "cut" && <button type="button" className="k-btn" data-testid="outside-send-again" onClick={() => void send(x.text, x.id)}>Send again</button>}
                  <button type="button" className="k-btn" data-quiet="" aria-label="Put it away" data-testid="outside-send-dismiss" onClick={() => void dismiss(x.id)}><X aria-hidden="true" /></button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {answering && (
        <form className="k-outside-compose" data-testid="outside-compose" onSubmit={(e) => { e.preventDefault(); void send(text); }}>
          <textarea
            className="k-outside-input"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !composing(e)) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }}
            rows={Math.min(6, Math.max(1, text.split("\n").length))}
            placeholder={shown}
            aria-label={placeholder}
            data-testid="outside-input"
          />
          {route === "steer" && (
            <button type="button" className="k-btn" data-testid="outside-stop" aria-label="Stop" disabled={stopping} aria-busy={stopping || undefined} onClick={() => void stop()} title={`Stop the turn Keel runs in ${where}`}><Square aria-hidden="true" /><span className="k-outside-btn-label">Stop</span></button>
          )}
          <button type="submit" className="k-btn" data-ink="" disabled={!text.trim()} data-testid="outside-send" aria-label={route === "terminal" ? "Type into the terminal" : `Send to ${where}`}><ArrowUp aria-hidden="true" /><span className="k-outside-btn-label">Send</span></button>
        </form>
      )}
      {typed && <p className="k-outside-note k-outside-said" data-testid="outside-typed">{typed}</p>}
      {notes.map((n) => <p key={n} className="k-outside-note k-outside-said" data-testid="outside-said">{n}</p>)}
      <p className="k-outside-note" data-testid="outside-note" data-quiet={!note && answering ? "" : undefined}>{note || quiet}</p>
    </section>
  );
}
