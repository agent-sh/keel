// Whose words these are. The owner's message is one block wherever it shows
// (the transcript, an imported conversation's preview): an ink rule, their
// words, and what they attached with them. What Keel told the model is a quiet
// line that says so, with the words it sent one press away.
import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../lib/utils.ts";

// `label`: who sent it when not typed here by the owner ("Steered into the turn").
// `attached`: their images and files, inside the block, under the words.
export function OwnerWords({ children, attached, label, className }: { children?: ReactNode; attached?: ReactNode; label?: ReactNode; className?: string }) {
  return (
    <div className={cn("k-owner-words", className)}>
      {label}
      {children}
      {attached && <div className="k-owner-attached">{attached}</div>}
    </div>
  );
}

// What the harness wrote for the model, shown to the owner as that: a label
// that names the speaker and the listener, a short account in Keel's voice,
// and the exact words behind a fold (in the page, so Find reaches them).
// `what`: the short account; `words`: what was sent, when it says more.
export function ToldModel({ id, what, words, testid }: { id: string; what: string; words?: string; testid: string }) {
  const head = (
    <>
      <span className="k-label k-told-who">Keel to the model</span>
      <span className="k-told-what">{what}</span>
    </>
  );
  if (!words || words.trim() === what.trim()) return <p id={`e-${id}`} data-event-id={id} className="k-told scroll-mt-6" data-testid={testid}>{head}</p>;
  return (
    <details id={`e-${id}`} data-event-id={id} className="k-told group/told scroll-mt-6" data-testid={testid}>
      <summary className="list-none">{head}<ChevronRight className="k-told-chev" aria-hidden="true" /></summary>
      <div className="k-told-words"><span className="k-label">Sent word for word</span>{words}</div>
    </details>
  );
}

// The short account of a note the model reads, and the words sent when they say more.
// The marks a note carries for the model (a tag, a "[harness]" lead, a log path) are not the owner's reading.
export function toldOf(data: { text?: unknown; short?: unknown; kind?: unknown }): { what: string; words?: string } {
  const sent = String(data.text ?? "").replace(/<\/?system-reminder>/g, "").replace(/^\[(harness|owner)\]\s*/, "").trim();
  if (data.kind === "tasks") {
    const items = sent.split("\n").filter((l) => /^\[.\] /.test(l)).length;
    return { what: `You changed the task list. It now has ${items === 1 ? "one item" : `${items} items`}.`, words: sent };
  }
  if (typeof data.short === "string" && data.short) return { what: data.short, words: sent };
  const first = sent.split("\n")[0]!.replace(/\. Output: \S+/g, ".");
  const what = first.length > 160 ? `${first.slice(0, 157).trimEnd()}...` : first;
  return { what, words: sent === what ? undefined : sent };
}
