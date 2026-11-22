// The box a failed turn leaves in the transcript. It leads with what failed
// in plain words, gives the provider's own words under that with any address
// in them as a link, and offers what fits the failure as labelled buttons:
// the page that fixes it (billing, the provider's settings), another model,
// trying again. A turn the provider asked to wait long for resumes by itself
// when the wait is over; the box says when, counts down, and lets the owner
// resume it now or call it off.
import { CircleAlert, Clock, ExternalLink, Play, RotateCw } from "lucide-react";
import { Fragment, useState } from "react";
import type { Session, StoredEvent } from "../../../src/core/types.ts";
import { actions, reportError } from "../lib/store.ts";
import { switchSession } from "../lib/switch.ts";
import { navigate } from "../lib/ui.ts";
import { clock, cn, fmtWait } from "../lib/utils.ts";
import { useNow } from "./Mark.tsx";
import { ModelPicker } from "./ModelPicker.tsx";

type Kind = "auth" | "rate" | "quota" | "overloaded" | "network" | "unreachable" | "invalid" | "context" | "server";
// What failed, in the owner's words. The provider's own message follows it.
const LEAD: Record<Kind, string> = {
  quota: "The provider's account is out of credit or over its quota.",
  rate: "The provider is limiting how often this account may ask.",
  auth: "The provider did not accept the credentials.",
  overloaded: "The provider is overloaded.",
  network: "The provider's answer broke off or went silent.",
  // A turn waits for a provider it cannot reach (src/providers/outage.ts): this box is a request made outside that wait, or the wait's end a week on.
  unreachable: "The provider could not be reached.",
  server: "The provider failed on its side.",
  context: "The conversation no longer fits the model's window.",
  invalid: "The provider refused the request as it was sent.",
};
// A failure stored before failures carried their kind is read from its status.
const kindOf = (kind: unknown, status?: number): Kind | undefined =>
  typeof kind === "string" && kind in LEAD ? (kind as Kind)
    : status === 402 ? "quota" : status === 429 ? "rate" : status === 401 || status === 403 ? "auth" : status === 529 || status === 503 ? "overloaded" : status && status >= 500 ? "server" : undefined;

const URL_RE = /https?:\/\/[^\s<>"'`)\]]+/g;
// An address in running text ends before the sentence's own punctuation.
const trimUrl = (u: string) => u.replace(/[.,;:!?]+$/, "");
export const firstUrl = (text: string) => { const m = text.match(URL_RE); return m ? trimUrl(m[0]) : undefined; };

function Linked({ text }: { text: string }) {
  const out: (string | { url: string })[] = [];
  let at = 0;
  for (const m of text.matchAll(URL_RE)) {
    const url = trimUrl(m[0]);
    out.push(text.slice(at, m.index), { url });
    at = m.index + url.length;
  }
  out.push(text.slice(at));
  return (
    <>
      {out.map((p, i) => (typeof p === "string" ? <Fragment key={i}>{p}</Fragment>
        : <a key={i} href={p.url} target="_blank" rel="noreferrer noopener" data-testid="failure-url" className="rounded-sm underline decoration-danger/50 underline-offset-2 outline-none hover:decoration-danger focus-visible:ring-2 focus-visible:ring-ring">{p.url}</a>))}
    </>
  );
}

const button = "flex h-7 items-center gap-1.5 rounded-md px-2.5 text-caption font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40";
const primary = "bg-accent text-accent-fg hover:bg-accent-hover";
const plain = "border border-line bg-raised text-fg hover:bg-hover";

// `live`: this is the failure the session stopped on, so its actions apply.
export function TurnFailure({ e, s, live }: { e: StoredEvent; s: Session; live: boolean }) {
  const message = String(e.data.message ?? "The turn failed.");
  const http = /^HTTP (\d+): /.exec(message);
  const status = typeof e.data.status === "number" ? e.data.status : http ? Number(http[1]) : undefined;
  const kind = kindOf(e.data.kind, status);
  const words = http ? message.slice(http[0].length) : message;
  const url = firstUrl(words);
  // Set while the session will go on by itself after this failure, and it is still the last thing in it.
  const due = s.settings.continue_at?.after === e.id ? s.settings.continue_at.at : undefined;
  const now = useNow(due !== undefined);
  const [picking, setPicking] = useState(false);
  const [pick, setPick] = useState("");
  const again = () => actions.resume(s.id).catch(reportError);
  // The fix is somewhere else (the account's billing, the provider's settings):
  // that page is the first button, and trying again comes after it. Any other
  // address the provider gave is a plain button after Try again.
  const fix = kind === "quota" && url ? { label: "Open billing", href: url }
    : kind === "auth" ? { label: "Open provider settings", run: () => navigate({ name: "settings", section: "providers" }) } : undefined;
  const page = !fix && url ? url : undefined;
  // It resumed by itself this many times and the provider asked for the wait again each time.
  const gaveUp = typeof e.data.continued === "number" ? e.data.continued : 0;
  const round = s.settings.continue_at?.round ?? 0;
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-danger/25 bg-danger-soft px-3.5 py-2.5 text-ui" data-testid="turn-error" data-event-id={e.id} data-kind={kind}>
      <div className="flex items-start gap-2.5">
        <CircleAlert className="mt-0.5 size-4 shrink-0 text-danger" />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-fg" data-testid="failure-lead">{kind ? LEAD[kind] : <Linked text={words} />}</p>
          {kind && (
            <p className="mt-0.5 whitespace-pre-wrap break-words text-danger" data-testid="failure-words">
              <Linked text={words} />
              {status !== undefined && <span className="ml-2 whitespace-nowrap rounded-sm bg-raised/60 px-1 py-px text-micro tabular-nums text-muted" data-testid="failure-status">HTTP {status}</span>}
            </p>
          )}
        </div>
      </div>
      {due !== undefined && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 pl-[1.625rem] text-fg" data-testid="resume-at">
          {/* In a narrow pane the parts go to rows of their own before one of them is squeezed into a column. */}
          <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
            <Clock className="size-3.5 shrink-0 text-muted" />
            <span>Resumes by itself at <span className="font-medium tabular-nums">{clock(due)}</span></span>
            <span className="whitespace-nowrap tabular-nums text-muted" data-testid="resume-in">{due > now ? `in ${fmtWait(due - now)}` : "now"}</span>
            {round > 0 && <span className="text-muted" data-testid="resume-round">after {round} {round === 1 ? "try" : "tries"}, waiting longer each time</span>}
          </span>
          <span className="flex flex-wrap items-center gap-1">
            <button type="button" data-testid="resume-now" className={cn(button, primary, "shrink-0 whitespace-nowrap")} onClick={again}>
              <Play className="size-3" /> Resume now
            </button>
            <button type="button" data-testid="resume-cancel" className={cn(button, "shrink-0 whitespace-nowrap text-muted hover:bg-hover hover:text-fg")} onClick={() => actions.cancelContinue(s.id).catch(reportError)}>
              Do not resume
            </button>
          </span>
        </div>
      )}
      {gaveUp > 0 && (
        <p className="pl-[1.625rem] text-fg" data-testid="resume-stopped">
          It resumed by itself {gaveUp} times and the provider asked for the wait each time, so it is not resumed again.
        </p>
      )}
      {live && due === undefined && (
        <div className="flex flex-wrap items-center gap-1.5 pl-[1.625rem]" data-testid="failure-actions">
          {fix && ("href" in fix
            ? <a href={fix.href} target="_blank" rel="noreferrer noopener" data-testid="failure-fix" className={cn(button, primary)}><ExternalLink className="size-3" /> {fix.label}</a>
            : <button type="button" data-testid="failure-fix" className={cn(button, primary)} onClick={fix.run}>{fix.label}</button>)}
          <button type="button" data-testid="try-again" className={cn(button, fix ? plain : primary)} onClick={again}>
            <RotateCw className="size-3" /> Try again
          </button>
          {page && <a href={page} target="_blank" rel="noreferrer noopener" data-testid="failure-page" className={cn(button, plain)}><ExternalLink className="size-3" /> Open the page</a>}
          {kind && !picking && <button type="button" data-testid="failure-switch" className={cn(button, plain)} onClick={() => setPicking(true)}>Switch model</button>}
          {picking && (
            <span className="flex items-center gap-1.5" data-testid="failure-models">
              <span className="rounded-md border border-line bg-raised"><ModelPicker value={pick || s.model} onChange={setPick} /></span>
              <button
                type="button"
                disabled={!pick || pick === s.model}
                className={cn(button, plain)}
                // The picker's switch (with its cache warning): Cancel leaves the model and does not try again.
                onClick={() => switchSession(s.id, { model: pick }).then((ok) => (ok ? actions.resume(s.id) : undefined)).catch(reportError)}
              >
                Try on it
              </button>
            </span>
          )}
        </div>
      )}
    </div>
  );
}
