// What a conversation with no messages shows. The helper's says what it does and offers a few
// things to ask it, each from what its tools reach (src/helper/helper.ts); any other session's
// says only that nothing is in it yet.
import { MessageSquare } from "lucide-react";
import { useState } from "react";
import { useHelper } from "../lib/helper.ts";
import { actions, failed } from "../lib/store.ts";

export function EmptyTranscript({ sessionId }: { sessionId: string }) {
  const helper = useHelper((s) => (s.view?.session_id === sessionId ? s.view : null));
  const [err, setErr] = useState("");
  if (!helper) return <p className="k-empty py-4">No messages yet.</p>;
  const asks = [
    "What needs me right now?",
    "What happened in my sessions today?",
    helper.mail.available ? "Is there mail I should answer today?" : "Remember that I review pull requests in the morning.",
  ];
  const ask = (text: string) => { setErr(""); actions.send(sessionId, text).catch((e) => setErr(failed(e, { at: "helper intro" }))); };
  return (
    <section className="flex flex-col gap-3 py-4" data-testid="helper-intro" aria-labelledby="helper-intro-title">
      <h2 id="helper-intro-title" className="text-base font-semibold text-fg">Your helper</h2>
      <p className="max-w-[38rem] text-ui leading-relaxed text-muted">
        One conversation that stays open. It follows your other sessions and tells you what needs you, {helper.mail.available ? `reads your mail${helper.mail.can?.calendar ? " and calendar" : ""}, ` : ""}and keeps what you tell it to remember. It wakes by itself for a failure, a usage limit{helper.mail.available ? " or mail that needs you" : ""}; the rest waits for your next message.
      </p>
      <p className="k-label mt-1">Ask it</p>
      <div className="flex flex-col items-start gap-1.5">
        {asks.map((a) => (
          <button key={a} type="button" data-testid="helper-ask" onClick={() => ask(a)}
            className="inline-flex min-h-8 items-center gap-2 rounded-lg border border-line bg-raised px-3 py-1 text-left text-ui text-fg hover:border-line-strong hover:bg-hover">
            <MessageSquare className="size-3.5 shrink-0 text-faint" />{a}
          </button>
        ))}
      </div>
      {err && <p className="text-caption text-danger" role="alert">{err}</p>}
    </section>
  );
}
