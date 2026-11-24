// The helper row, first on a phone's home: a question for the helper, and its
// answer as text with the sessions it read named. Push to talk is the app's
// (the phone's own recognizer, words only). The page has no microphone of its
// own: the Web Speech API sends audio to a service unless it processes it on
// the device, and asking a browser whether it can (SpeechRecognition.available)
// crashes the renderer of a Chromium without its speech component. The
// phone's keyboard dictates into the box as it does anywhere. The answer only reads;
// what it offers is the owner's tap: open a session it read, or answer what
// that session waits on (openWaiting, the way every row of the home goes to a
// request). The helper's conversation keeps the question and the answer.
import { ArrowUp, Sparkles, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { Session } from "../../../src/core/types.ts";
import { ask, dismiss, lookAgain, pending, readLine, resume, useAsk } from "../lib/ask.ts";
import { useStore } from "../lib/store.ts";
import { navigate } from "../lib/ui.ts";
import { cn } from "../lib/utils.ts";
import { useSessionStates } from "../lib/watch.ts";
import { openWaiting } from "./HomeWatch.tsx";
import { Markdown } from "./Markdown.tsx";

const WORKING: Record<string, string> = { waiting: "Asked. The helper starts on it.", working: "The helper is reading your sessions." };

export function HelperAsk() {
  const answer = useAsk((s) => s.answer);
  const asking = useAsk((s) => s.asking);
  const error = useAsk((s) => s.error);
  const unanswered = useAsk((s) => s.unanswered);
  const [text, setText] = useState("");
  useEffect(resume, []);
  const send = () => { const t = text; setText(""); void ask(t); };
  const sessions = useStore((s) => s.sessions);
  const read = useMemo(() => (answer?.read ?? []).map((r) => sessions[r.id]).filter((s): s is Session => !!s), [answer, sessions]);
  const states = useSessionStates(read);

  return (
    <section className="k-ask" data-testid="helper-ask" aria-label="Ask the helper">
      <form className="k-ask-row" onSubmit={(e) => { e.preventDefault(); send(); }}>
        <Sparkles className="k-ask-mark" aria-hidden />
        <input
          className="k-ask-field" data-testid="helper-ask-field" dir="auto" enterKeyHint="send"
          value={text} onChange={(e) => setText(e.target.value)}
          placeholder="Ask the helper" aria-label="Question for the helper"
        />
        <button type="submit" className="k-ask-btn k-ask-btn-send" data-testid="helper-ask-send" aria-label="Ask" disabled={!text.trim() || asking}><ArrowUp /></button>
      </form>
      {error && <p className="k-ask-note" data-testid="helper-ask-error" role="status">{error}</p>}
      {answer && (
        <div className="k-ask-answer" data-testid="helper-answer" data-state={answer.state} aria-live="polite">
          <div className="k-ask-q">
            <span dir="auto" className="min-w-0 flex-1 truncate" data-testid="helper-answer-q">{answer.question}</span>
            <button type="button" className="k-ask-x" aria-label="Clear the answer" data-testid="helper-answer-clear" onClick={dismiss}><X /></button>
          </div>
          {unanswered && pending(answer.state) ? (
            <p className="k-ask-note k-ask-late" data-testid="helper-answer-late">
              The helper did not answer.
              <button type="button" className="k-ask-again" data-testid="helper-answer-again" onClick={lookAgain}>Look again</button>
            </p>
          ) : pending(answer.state) && !answer.text && <p className="k-ask-wait" data-testid="helper-answer-wait"><span className="k-mark" data-watch="work" aria-hidden />{WORKING[answer.state]}</p>}
          {answer.text && <div className="k-ask-text" data-testid="helper-answer-text"><Markdown text={answer.text} /></div>}
          {answer.state === "failed" && <p className="k-ask-note" data-testid="helper-answer-failed">The helper's turn failed. Its conversation says why.</p>}
          {answer.state === "stopped" && <p className="k-ask-note">The helper was stopped before it answered.</p>}
          {readLine(answer) && <p className="k-ask-read" data-testid="helper-answer-read">{readLine(answer)}</p>}
          <div className="k-home-acts k-ask-acts">
            {/* Answer first, where a session it read waits for the owner (as the app orders them, Asked.kt). */}
            {[...answer.read].sort((x, y) => Number(y.waits > 0) - Number(x.waits > 0)).map((r) => {
              const waits = r.waits > 0;
              const st = states[r.id];
              return (
                <button
                  key={r.id} type="button" className={cn("k-home-act", waits && "k-home-act-lead")} data-testid="helper-answer-act" data-session={r.id} data-act={waits ? "answer" : "open"}
                  onClick={() => (waits ? openWaiting(r.id, st?.child, st?.why) : navigate({ name: "session", id: r.id }))}
                >{waits ? `Answer ${r.title}` : `Open ${r.title}`}</button>
              );
            })}
            <button type="button" className="k-home-act" data-quiet data-testid="helper-answer-open" onClick={() => navigate({ name: "session", id: answer.chat_id })}>Go on with the helper</button>
          </div>
        </div>
      )}
    </section>
  );
}
