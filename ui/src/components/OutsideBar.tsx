// A session another harness runs, in the composer's place: Keel shows what it
// writes, its state from its own records, what it spent, the files its calls
// changed and who holds it now. A Codex session nothing else holds is answered
// here: the text goes to that same session in Codex (src/integrations/outside/
// codex-app.ts), the reply comes into this view as Codex writes it, and what
// Codex asks comes as Keel's cards above. While another process holds it, the
// bar says who and offers nothing that writes. One press copies it into Keel
// (a copy that goes on here; the original keeps running where it runs).
import { ArrowUp, ChevronDown, ChevronRight, CornerDownRight, Square, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Holder, Session, Usage } from "../../../src/core/types.ts";
import { shortPath } from "../../../src/core/tool-line.ts";
import { OUTSIDE_LABEL } from "../../../src/core/watch.ts";
import { holderSaid } from "../../../src/core/holder-words.ts";
import { api, failed, onFeature, reportUnlessGone } from "../lib/store.ts";
import { composing } from "../lib/keys.ts";
import { navigate } from "../lib/ui.ts";
import { clock, fmtSessionCost, fmtTokens } from "../lib/utils.ts";
import { useSessionState } from "../lib/watch.ts";
import { setAnswers, type Answered } from "../lib/outside-answers.ts";
import { Mark } from "./Mark.tsx";

type Send = { id: string; text: string; state: "stored" | "started" | "delivered" | "lost" | "failed" | "cut"; said: string | null };
type Route = "resume" | "steer" | "held" | "missing" | "unlocked" | "none";
type Details = {
  harness: string; label: string; source_id: string; path: string; live: boolean; files: string[]; usage: { model: string; usage: Usage; cost: number | null }[];
  holder?: Holder; route?: Route; turn?: boolean; sends?: Send[]; notes?: string[]; answers?: Record<string, Answered>;
};

const tokensOf = (u: Usage) => u.input + u.output + u.cache_read + u.cache_write;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

export function OutsideBar({ session }: { session: Session }) {
  const o = session.outside!;
  const where = OUTSIDE_LABEL[o.harness] ?? o.harness;
  const st = useSessionState(session);
  const [d, setD] = useState<Details | null>(null);
  const [files, setFiles] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
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
  const go = async () => {
    setBusy(true);
    setNote("");
    try {
      const r = await api<{ session: { id: string } }>(`/api/sessions/${session.id}/outside/copy`, { method: "POST" });
      navigate({ name: "session", id: r.session.id });
    } catch (e) {
      setNote(failed(e, { at: "OutsideBar copy" }));
    } finally {
      setBusy(false);
    }
  };
  // What a send does now, from who holds it: Keel resumes it, adds to the turn Keel runs, or nothing.
  const route: Route = o.harness !== "codex" ? "none" : holder?.kind === "keel" ? "steer" : holder && holder.kind !== "free" ? "held" : d?.route === "missing" || d?.route === "unlocked" ? d.route : "resume";
  const send = async (words: string, again?: string) => {
    if (!words.trim()) return;
    setNote("");
    const key = again ? `again-${again}` : draftKey.current;
    // The box is cleared before the request goes, and the next draft gets a key of its own.
    if (!again) { setText(""); draftKey.current = crypto.randomUUID(); }
    try {
      await api(`/api/sessions/${session.id}/outside/send`, { method: "POST", body: JSON.stringify({ text: words, client_id: key, ...(again ? { again } : {}) }) });
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
  const said = st.watch === "need" && o.state !== "waiting" ? `Waits for your answer: ${where} asks above` : o.state === "waiting" ? `Waits in ${where} for ${o.waiting_for ?? "your answer"}` : o.state === "working" ? `Working in ${where}` : o.state === "stale" ? `No record from ${where}` : `Done in ${where}`;
  const u = session.usage;
  const cost = typeof u.cost === "number" && !u.unpriced ? fmtSessionCost(u.cost) : typeof u.cost === "number" && u.cost > 0 ? `${fmtSessionCost(u.cost)} and more unpriced` : "";
  const spent = [o.model, tokensOf(u) ? `${fmtTokens(tokensOf(u))} tokens` : "", cost].filter(Boolean).join(" · ");
  const answering = route === "resume" || route === "steer";
  const pending = (sends ?? []).filter((x) => x.state !== "delivered");
  const placeholder = route === "steer" ? `Add to the turn Keel runs in ${where}` : `Answer here: Keel resumes this session in ${where}`;
  const quiet = route === "held" ? `${holderSaid(holder, where)}: answer it there. Keel sends nothing while another process holds it.`
    : route === "missing" ? `No codex program here: Keel answers a ${where} session with the codex on your PATH.`
    : route === "unlocked" ? `This ${where} keeps no writer locks, so Keel cannot tell whether a terminal has it open: answer it there, or update ${where}.`
    : route === "none" ? `Read-only here: Keel sends nothing to ${where}. Copy into Keel makes a copy you work on here; the session there keeps running.`
    : `Sent to this same session in ${where}: its reply comes here, and what it asks comes as cards. Copy into Keel makes a copy instead.`;
  return (
    <section className="k-outside" data-testid="outside-bar" data-state={st.watch === "need" ? "waiting" : o.state} data-harness={o.harness} data-answering={answering ? "" : undefined} aria-label={`${where} session`}>
      <div className="k-outside-head">
        <Mark w={st.watch} />
        <div className="min-w-0 flex-1">
          <p className="k-outside-state" data-testid="outside-state">
            {said}
            {o.since > 0 && <span className="k-outside-since" title={`Since ${clock(o.since, { seconds: true })}`}> since {clock(o.since)}</span>}
          </p>
          <p className="k-outside-facts" data-testid="outside-facts">
            <span className="k-outside-holder" data-testid="outside-holder" data-kind={holder?.kind ?? "free"}>{holderSaid(holder, where)}</span>
            {spent && <span data-testid="outside-spent">{spent}</span>}
            {o.files > 0 && (
              <button type="button" className="k-outside-files-btn" aria-expanded={files} data-testid="outside-files-toggle" onClick={() => setFiles((x) => !x)}>
                {files ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}{plural(o.files, "file")} changed
              </button>
            )}
            {o.failures > 0 && <span className="k-outside-failed" data-testid="outside-failures">{plural(o.failures, "failed call")}</span>}
          </p>
        </div>
        <button type="button" className="k-btn k-btn-lg" data-ink={answering ? undefined : ""} data-testid="outside-copy" disabled={busy} onClick={go} aria-label="Copy into Keel" title={`A copy goes on here; the session in ${where} keeps running there`}>
          <CornerDownRight aria-hidden="true" /><span className="k-outside-copy-label">Copy into Keel</span>
        </button>
      </div>
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
            placeholder={placeholder}
            aria-label={placeholder}
            data-testid="outside-input"
          />
          {route === "steer" && (
            <button type="button" className="k-btn" data-testid="outside-stop" disabled={stopping} aria-busy={stopping || undefined} onClick={() => void stop()} title={`Stop the turn Keel runs in ${where}`}><Square aria-hidden="true" />Stop</button>
          )}
          <button type="submit" className="k-btn" data-ink="" disabled={!text.trim()} data-testid="outside-send" aria-label={`Send to ${where}`}><ArrowUp aria-hidden="true" />Send</button>
        </form>
      )}
      {notes.map((n) => <p key={n} className="k-outside-note k-outside-said" data-testid="outside-said">{n}</p>)}
      <p className="k-outside-note" data-testid="outside-note" data-quiet={!note && answering ? "" : undefined}>{note || quiet}</p>
    </section>
  );
}
