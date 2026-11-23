import { CircleAlert, ExternalLink, GitPullRequest, KeyRound, Loader2, RotateCcw, Send, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { QUEUED, STATE_WORD } from "../../../src/core/state-words.ts";
import type { Session } from "../../../src/core/types.ts";
import type { PrReview, Watched } from "../../../src/prreview/watch.ts";
import { composing } from "../lib/keys.ts";
import { api, failed, onFeature, readAtOpen, reportError } from "../lib/store.ts";
import { navigate } from "../lib/ui.ts";
import { ago, cn } from "../lib/utils.ts";
import { Card, Segmented, SettingRow } from "./Settings.tsx";

type Listing = { repos: Watched[]; reviews: PrReview[]; credentials: "keel" | "env" | "gh" | null };

const STATE: Record<PrReview["state"], string> = { queued: QUEUED, running: "Reviewing", draft: "Draft", posting: "Posting", posted: "Posted", failed: STATE_WORD.fail };
const TONE: Record<PrReview["state"], string> = {
  queued: "bg-sunken text-muted", running: "bg-accent-soft text-accent-ink", draft: "bg-warn/15 text-warn", posting: "bg-accent-soft text-accent-ink", posted: "bg-ok/15 text-ok", failed: "bg-danger-soft text-danger",
};
const PCLS = ["bg-danger text-accent-fg", "bg-danger-soft text-danger", "bg-warn/15 text-warn", "bg-sunken text-muted"];
const WHY: Record<PrReview["why"], string> = { opened: "opened", updated: "new push", asked: "asked" };
const CRED: Record<string, string> = { keel: "the token saved here", env: "GH_TOKEN or GITHUB_TOKEN of the daemon", gh: "your gh login" };
const button = "k-btn k-btn-lg";
const primary = "inline-flex h-8 items-center gap-1.5 rounded-md bg-accent px-3 text-ui font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-40";

function StateChip({ r }: { r: PrReview }) {
  return (
    <span className={cn("inline-flex h-5 shrink-0 items-center gap-1 rounded-full px-2 text-micro font-medium", TONE[r.state])} data-testid="pr-review-state" data-state={r.state}>
      {(r.state === "running" || r.state === "posting") && <Loader2 className="size-3 animate-spin" />}
      {STATE[r.state]}
    </span>
  );
}

// Posting a draft: one button, its failure said beside it.
function PostButton({ r, onDone, quiet }: { r: PrReview; onDone?: (r: PrReview) => void; quiet?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  if (r.state !== "draft") return null;
  const post = async () => {
    setBusy(true);
    setErr("");
    try { onDone?.((await api<{ review: PrReview }>(`/api/pr-reviews/${r.id}/post`, { method: "POST" })).review); } catch (e) { setErr(failed(e, { at: "post pull request review" })); } finally { setBusy(false); }
  };
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button type="button" data-testid="pr-review-post" disabled={busy} onClick={post} className={quiet ? button : primary}>
        {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />} Post to GitHub
      </button>
      {(err || r.post_error) && <span className="text-caption text-danger" data-testid="pr-review-post-error">{err || r.post_error}</span>}
    </span>
  );
}

function useListing() {
  const [l, setL] = useState<Listing | null>(null);
  const load = useCallback(() => api<Listing>("/api/pr-reviews").then(setL), []);
  useEffect(() => {
    const read = readAtOpen(load, "pull request reviews");
    const off = onFeature({
      reconnect: read,
      frame: (f) => {
        if (f.name !== "pr-reviews") return;
        if (f.data.repos) setL((x) => (x ? { ...x, repos: f.data.repos } : x));
        if (f.data.review) setL((x) => (x ? { ...x, reviews: [f.data.review, ...x.reviews.filter((r) => r.id !== f.data.review.id)].sort((a, b) => b.created - a.created) } : x));
      },
    });
    return off;
  }, [load]);
  return [l, load] as const;
}

function RepoCard({ w, reload }: { w: Watched; reload: () => void }) {
  const [trigger, setTrigger] = useState(w.trigger);
  useEffect(() => setTrigger(w.trigger), [w.trigger]);
  const path = `/api/pr-reviews/repos/${w.repo.split("/").map(encodeURIComponent).join("/")}`;
  const patch = (b: Partial<Watched>) => api(path, { method: "PATCH", body: JSON.stringify(b) }).then(reload).catch(reportError);
  const pace = w.interval_s ? `every ${w.interval_s} s, as GitHub asks` : "every 60 s until GitHub states a pace";
  return (
    <Card>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 py-3" data-testid="pr-watch" data-repo={w.repo}>
        <GitPullRequest className="size-4 text-accent" />
        <span className="font-mono text-ui font-medium">{w.repo}</span>
        <span className="text-caption text-faint" data-testid="pr-watch-status">
          {w.last_poll ? `read ${ago(w.last_poll)} ago` : "not read yet"} · {pace} · {w.requests} request{w.requests === 1 ? "" : "s"}, {w.unchanged} unchanged
        </span>
        <button type="button" data-testid="pr-unwatch" title={`Stop watching ${w.repo}`} onClick={() => api(path, { method: "DELETE" }).then(reload).catch(reportError)} className="ml-auto inline-flex h-7 items-center gap-1 rounded-md px-2 text-caption text-muted hover:bg-hover hover:text-danger">
          <Trash2 className="size-3.5" /> Stop watching
        </button>
      </div>
      {w.error && <p className="-mt-1 flex items-center gap-1.5 pb-2 text-caption text-warn" data-testid="pr-watch-error"><CircleAlert className="size-3.5" />{w.error}</p>}
      <div className="border-t border-line">
        <SettingRow label="Review" hint="A new head of a ready pull request, a new pull request only, or only when a comment asks. Drafts are reviewed when asked.">
          <Segmented label="Review" value={w.auto} onChange={(v) => patch({ auto: v })} options={[{ value: "push", label: "Every push" }, { value: "open", label: "New pull requests" }, { value: "comment", label: "When asked" }]} />
        </SettingRow>
        <SettingRow label="Post on GitHub" hint={w.post ? "Each review is posted as a comment review by itself, with its findings on their lines." : "Each review is a draft you read here and post with one button."}>
          <Segmented label="Post on GitHub" value={w.post ? "post" : "draft"} onChange={(v) => patch({ post: v === "post" })} options={[{ value: "draft", label: "Draft first" }, { value: "post", label: "Post by itself" }]} />
        </SettingRow>
        <SettingRow label="Asked with" hint="A comment whose first line starts with these words, by someone with write access, asks for a review of the head.">
          <input
            value={trigger}
            onChange={(e) => setTrigger(e.target.value)}
            onBlur={() => trigger.trim() && trigger !== w.trigger && patch({ trigger })}
            onKeyDown={(e) => { if (!composing(e) && e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
            aria-label={`Trigger of ${w.repo}`}
            data-testid="pr-trigger"
            className="k-field w-48 font-mono text-caption"
          />
        </SettingRow>
      </div>
    </Card>
  );
}

function Token({ source, reload }: { source: Listing["credentials"]; reload: () => void }) {
  const [v, setV] = useState("");
  const save = () => api("/api/pr-reviews/token", { method: "PUT", body: JSON.stringify({ token: v }) }).then(() => { setV(""); reload(); }).catch(reportError);
  return (
    <SettingRow label="GitHub access" hint={source ? `Keel reads GitHub with ${CRED[source]}. The token is never shown or written to a file.` : "No credentials: sign in with gh (gh auth login), or save a token here. It is kept in the system keyring."}>
      <div className="flex items-center gap-2" data-testid="pr-credentials" data-source={source ?? "none"}>
        <KeyRound className="size-4 text-faint" />
        <input type="password" value={v} onChange={(e) => setV(e.target.value)} placeholder={source === "keel" ? "Saved: type to replace" : "Token (optional)"} aria-label="GitHub token" className="k-field w-52" />
        <button type="button" disabled={!v.trim()} onClick={save} className={button}>Save</button>
        {source === "keel" && <button type="button" onClick={() => api("/api/pr-reviews/token", { method: "DELETE" }).then(reload).catch(reportError)} className="h-8 rounded-md px-2 text-caption text-muted hover:text-fg">Remove</button>}
      </div>
    </SettingRow>
  );
}

// Settings > Pull requests: the repositories Keel watches on GitHub, and the reviews it made.
export default function PrReviewSettings() {
  const [l, reload] = useListing();
  const [repo, setRepo] = useState("");
  const [err, setErr] = useState("");
  if (!l) return null;
  const add = async () => {
    setErr("");
    try { await api("/api/pr-reviews/repos", { method: "POST", body: JSON.stringify({ repo }) }); setRepo(""); reload(); } catch (e) { setErr(failed(e, { at: "watch repository" })); }
  };
  return (
    <div className="flex flex-col gap-4" data-testid="pr-review-settings">
      <Card>
        <SettingRow label="Watch a repository" hint="Keel reads its pull requests and comments at the pace GitHub states, with no public address. A change GitHub reports costs one request; an unchanged list costs none against the hourly limit.">
          <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); add(); }}>
            <input value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="owner/name" aria-label="Repository" data-testid="pr-watch-input" className="k-field w-52 font-mono" />
            <button type="submit" disabled={!repo.trim()} data-testid="pr-watch-add" className={primary}>Watch</button>
          </form>
        </SettingRow>
        {err && <p className="pb-3 text-caption text-danger" data-testid="pr-watch-add-error">{err}</p>}
        <Token source={l.credentials} reload={reload} />
      </Card>
      {l.repos.map((w) => <RepoCard key={w.repo} w={w} reload={reload} />)}
      <Card>
        <div className="flex items-center py-3 text-ui font-medium">Reviews<span className="ml-2 font-normal text-faint">{l.reviews.length}</span></div>
        <div className="-mx-5 border-t border-line" data-testid="pr-review-list">
          {!l.reviews.length && <p className="k-empty px-5 py-4">No review yet. A new push or a comment that asks starts one.</p>}
          {l.reviews.map((r) => (
            <div key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line/60 px-5 py-2.5 text-ui last:border-0" data-testid="pr-review-row" data-head={r.head}>
              <StateChip r={r} />
              <span className="font-mono text-caption">{r.repo}#{r.number}</span>
              <span className="font-mono text-micro text-faint">{r.head.slice(0, 7)}</span>
              <span className="min-w-0 flex-1 truncate">{r.title}</span>
              <span className="text-caption text-faint">{WHY[r.why]}{r.asked_by ? ` by ${r.asked_by}` : ""} · {ago(r.created)} ago{r.state === "draft" || r.state === "posted" ? ` · ${r.findings.length} finding${r.findings.length === 1 ? "" : "s"}` : ""}</span>
              {r.session_id && <button type="button" data-testid="pr-review-open" onClick={() => navigate({ name: "session", id: r.session_id! })} className="k-link text-caption font-medium text-accent hover:underline">Open</button>}
              {r.state === "failed" && <button type="button" data-testid="pr-review-retry" onClick={() => api(`/api/pr-reviews/${r.id}/retry`, { method: "POST" }).catch(reportError)} className={button}><RotateCcw className="size-3.5" /> Again</button>}
              {r.posted_url && <a href={r.posted_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-caption text-muted hover:text-fg">On GitHub <ExternalLink className="size-3" /></a>}
              <PostButton r={r} quiet />
              {r.error && <p className="basis-full text-caption text-danger">{r.error}</p>}
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

// The side panel of a review session: the draft the owner reads, and the one
// button that posts it.
export function PrReviewPanel({ session }: { session: Session }) {
  const [r, setR] = useState<PrReview | null>(null);
  const [post, setPost] = useState<boolean | null>(null);
  useEffect(() => {
    const load = () => api<{ review: PrReview; repo: Watched | null }>(`/api/pr-reviews/session/${session.id}`).then((x) => { setR(x.review); setPost(x.repo?.post ?? null); });
    const read = readAtOpen(load, "pull request review");
    return onFeature({ reconnect: read, frame: (f) => { if (f.name === "pr-reviews" && f.data.review?.session_id === session.id) setR(f.data.review); } });
  }, [session.id]);
  if (!r) return <p className="k-empty p-4">Not a pull request review.</p>;
  const open = r.findings.filter((f) => f.state !== "dismissed");
  return (
    <section className="flex flex-col gap-3 p-3" data-testid="pr-review-panel" data-state={r.state}>
      <div className="rounded-xl border border-line bg-raised p-3">
        <div className="flex items-center gap-2">
          <GitPullRequest className="size-4 text-accent" />
          <a href={r.url} target="_blank" rel="noreferrer" className="font-mono text-ui font-medium hover:underline">{r.repo}#{r.number}</a>
          <span className="font-mono text-micro text-faint">{r.head.slice(0, 7)}</span>
          <span className="ml-auto"><StateChip r={r} /></span>
        </div>
        <p className="mt-1.5 text-ui">{r.title}</p>
        <p className="mt-0.5 text-caption text-faint">by {r.author || "someone"} · {WHY[r.why]}{r.asked_by ? ` by ${r.asked_by}` : ""} · into {r.base}{r.files ? ` · ${r.files} file${r.files === 1 ? "" : "s"}` : ""}</p>
        {r.summary && <p className="mt-2 text-caption text-muted">{r.summary}</p>}
        {r.error && <p className="mt-2 text-caption text-danger">{r.error}</p>}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <PostButton r={r} onDone={setR} />
          {r.state === "posted" && (
            <a href={r.posted_url ?? r.url} target="_blank" rel="noreferrer" data-testid="pr-review-posted" className="inline-flex items-center gap-1 text-caption font-medium text-ok hover:underline">
              Posted {r.posted_at ? `${ago(r.posted_at)} ago` : ""}{r.posted_by === "auto" ? " by itself" : ""} <ExternalLink className="size-3" />
            </a>
          )}
          {r.state === "draft" && <span className="text-caption text-faint">{post ? "This repository posts by itself; this one waited." : "Nothing is on GitHub until you post it."}</span>}
        </div>
      </div>
      {(r.state === "draft" || r.state === "posted" || r.state === "posting") && (
        <ul className="flex flex-col rounded-xl border border-line bg-raised py-1" data-testid="pr-review-findings">
          {!open.length && <li className="k-empty px-3 py-2">No findings.</li>}
          {open.map((f) => (
            <li key={f.id} className="flex items-start gap-2.5 px-3 py-2" data-testid="pr-review-finding">
              <span className={cn("mt-0.5 shrink-0 rounded px-1 font-mono text-micro font-medium", f.priority === null ? "border border-line text-faint" : PCLS[f.priority])}>{f.priority === null ? "unrated" : `P${f.priority}`}</span>
              <div className="min-w-0 flex-1">
                <div className="text-caption font-medium">{f.title}</div>
                <div className="font-mono text-micro text-faint">{f.file}:{f.line}{f.end_line ? `-${f.end_line}` : ""}</div>
                {f.body && <p className="mt-0.5 whitespace-pre-wrap text-caption text-muted">{f.body}</p>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
