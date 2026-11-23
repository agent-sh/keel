import { Collapsible } from "@base-ui/react/collapsible";
import { Ansi } from "./Ansi.tsx";
import { Brain, Check, Circle, CircleDot, Link2, RotateCcw, SquareTerminal, X } from "lucide-react";
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { setUI, useUI } from "../lib/ui.ts";
import type { ToolResultBlock, ToolUseBlock } from "../../../src/core/types.ts";
import { diffLines, splitLines } from "../../../src/tools/diff.ts";
import type { PatchLine } from "../../../src/safety/patch.ts";
import { actions, api, failed, reportError } from "../lib/store.ts";
import { bounded } from "../lib/scrollback.ts";
import { scrollToError } from "../lib/error-scroll.ts";
import { CALL_STOPPED, NOT_RUN, callState, changeOf, commandText, failureLine, familyOf, moreLines, NEEDS_APPROVAL, noSuchTool, ranOf, refusalOf, shortPaths, smallChange } from "../lib/work.ts";
import { useCallsLive } from "../lib/call-live.ts";
import { marksOf, useMarked } from "../lib/marks.ts";
import { callHeld, callKey, letGo, useHeld, useLetGoUnseen } from "../lib/held.ts";
import { useAuto } from "../lib/automation.ts";
import { STATE_WORD } from "../../../src/core/state-words.ts";
import { commandOf } from "../../../src/core/command.ts";
import { ThoughtMark } from "./Work.tsx";
import { CallDiff, type CallFile } from "./DiffView.tsx";
import { RESTART_RAN, denialReason, notRun, quietEnd, stopKind, stoppedByUser } from "../../../src/core/stops.ts";
import { allowRetry, useBlocked } from "../lib/blocked.ts";
import {
  patchFiles, planItems, resultImages, resultText, shellBody, splitMemory, splitNested, shellStatus, shortPath, toolKind, type PlanItem,
  type ToolKind,
} from "../lib/tools.ts";
import { FLEET_LABEL, fleetSummary, MachineBadge } from "./Fleet.tsx";
import { cn, fmtWait } from "../lib/utils.ts";
import { AGENT_TOOLS, AgentCall, toolSummary } from "./automation/TranscriptExtras.tsx";
import { CodeCall } from "./CodeCall.tsx";
import { ReadersCall } from "./ReadersCall.tsx";
import { AskedUnder, QuestionCard } from "./QuestionCard.tsx";
import { Copyable, CopyButton } from "./CopyButton.tsx";
import { stripAnsiText } from "../../../src/core/ansi.ts";
import { splitDiagnostics, type ResultDiagnostics } from "../lib/tools.ts";

// The file a call names, for its copy line.
const pathOf = (input: any): string | undefined => { const p = input?.file_path ?? input?.path ?? input?.notebook_path; return typeof p === "string" && p ? p : undefined; };

// What a call did, as its line begins: one word while it runs, one when it is over, and the plain
// verb for a call that did neither (it waits, failed, was cut or stopped: the word beside it says which).
// (The third: the plain verb, for a call that was not carried out: it waits, was turned away or never got a result.)
const LABEL: Partial<Record<ToolKind, [string, string, string]>> = {
  shell: ["Running", "Ran", "Run"], stdin: ["Sending input", "Sent input", "Input"], stop: ["Stopping", "Stopped", "Stop"], read: ["Reading", "Read", "Read"],
  edit: ["Editing", "Edited", "Edit"], write: ["Writing", "Wrote", "Write"], patch: ["Patching", "Patched", "Patch"], notebook: ["Editing", "Edited", "Edit"],
  search: ["Searching", "Searched", "Search"], glob: ["Finding", "Found", "Find"], list: ["Listing", "Listed", "List"], web: ["Searching the web", "Searched the web", "Web search"],
  fetch: ["Fetching", "Fetched", "Fetch"], plan: ["Plan", "Plan", "Plan"], ask: ["Question", "Question", "Question"], skill: ["Loading skill", "Skill", "Skill"],
};

// `lead`: what the model thought on the way to it, shown when the call is opened.
// `auto`: the call stands on the rail by itself (a step of one call, or a call shown under its closed
// step): a command that runs is open there, and its output follows. In an opened step it is a line.
// `peek`: a copy of the call shown while its step is closed: a search hit is not taken by it.
// `quiet`: why the call is marked is said once above it, for every call marked the same: its own line does not repeat it.
// `event`: the event the call is of (a program asks for its marks again as it makes calls).
type Props = { use: ToolUseBlock; result?: ToolResultBlock; live?: boolean; sessionId?: string; cwd?: string; lead?: ReactNode; auto?: boolean; peek?: boolean; quiet?: boolean; event?: string };

function summary(kind: ToolKind, name: string, input: any, cwd?: string): string {
  switch (kind) {
    // The command itself: what the model calls it is the model's word for it (the line's tooltip).
    case "shell": return (commandOf(input) ?? "").split("\n").find((l) => l.trim())?.trim() ?? "";
    case "stdin": return input.chars ? JSON.stringify(input.chars) : `poll session ${input.session_id ?? ""}`;
    case "stop": return input.task_id ?? input.shell_id ?? "";
    case "read": {
      const p = shortPath(input.file_path ?? "", cwd);
      const from = input.offset ?? input.start_line;
      const range = input.pages ? ` pages ${input.pages}` : from || input.limit || input.end_line ? `:${from ?? 1}${input.limit ? `+${input.limit}` : input.end_line ? `-${input.end_line}` : ""}` : "";
      return p + range;
    }
    case "edit": case "write": return shortPath(input.file_path ?? "", cwd);
    case "notebook": return shortPath(input.notebook_path ?? "", cwd);
    case "patch": return patchFiles(patchText(input)).map((f) => f.path).join(", ");
    case "search": { const at = input.path ?? input.dir_path; return `${input.pattern ?? ""}${at && at !== cwd ? `  in ${shortPath(at, cwd)}` : ""}`; }
    case "glob": return input.pattern ?? "";
    case "list": return shortPath(input.dir_path ?? "", cwd);
    case "web": return input.query ?? "";
    case "fetch": return input.url ?? input.prompt ?? "";
    case "skill": return [input.skill ?? input.name, input.args ?? input.arguments].filter(Boolean).join(" ");
    // A dispatcher names its tool; a tool called by its own name shows its input.
    case "mcp": return name === "search_tools" || name === "ToolSearch" ? `search ${input.query ?? ""}` : input.tool ?? (JSON.stringify(input).slice(0, 120) || name);
    case "plan": return planSummary(planItems(name, input));
    default: return toolSummary(name, input) ?? fleetSummary(name, input) ?? JSON.stringify(input).slice(0, 120);
  }
}

const patchText = (input: any) => (typeof input === "string" ? input : String(input?.input ?? input?.patch ?? ""));

function planSummary(items: PlanItem[]): string {
  const done = items.filter((i) => i.status === "completed").length;
  const now = items.find((i) => i.status === "in_progress");
  return `${done} of ${items.length} done${now ? `, now: ${now.active ?? now.text}` : ""}`;
}

// What the owner's hooks did to a call rides with its result: the input they
// gave it in place of the model's, and an allow that answered its ask.
// `failed`: a hook of the call that failed, in its Errors row's words ("Hook timed out (PreToolUse, 5 s): hook.sh pre").
type HookMark = { input?: any; allowed?: string; failed?: string[] };
export const hookOf = (result: ToolResultBlock | undefined) => (result as (ToolResultBlock & { shown?: { hook?: HookMark } }) | undefined)?.shown?.hook;

// Under a call's line, opened or not: rows of who said or did something about
// it, and what. One grammar for every such row (a failure's reason, the
// owner's denial, a refusal, a hook, a language server): the name stands in
// the verbs' column, the words after it.
// Between a line's words and what stands at its end: nothing on the page, a break in a copied selection
// (the two are parts of a flex row, which a selection joins with nothing between them).
export const Apart = () => <span className="k-apart" aria-hidden="true">{"  "}</span>;

export function Under({ name, tone, code, testid, act, children }: { name?: string; tone?: "fail" | "warn" | "note"; code?: boolean; testid?: string; act?: ReactNode; children: ReactNode }) {
  return (
    <div className="k-under-row" data-testid={testid}>
      <span className="k-under-name">{name}</span>
      <span className="k-under-what" data-tone={tone} data-code={code ? "" : undefined}>{children}</span>
      {act}
    </div>
  );
}

// What a hook of the owner's did: what the model had asked for (the call shows
// the input that ran), and the hook that let it through, in its own words.
function HookRows({ hook, asked, name, cwd }: { hook: HookMark; asked: any; name: string; cwd?: string }) {
  if (hook.input === undefined && !hook.allowed && !hook.failed?.length) return null;
  return (
    <div className="k-under" data-testid="tool-hook">
      {hook.failed?.map((f, i) => <Under key={i} name="Hook" tone="warn" testid="tool-hook-failed">{f.replace(/^Hook /, "")}</Under>)}
      {hook.input !== undefined && <Under name="Model">asked for <span className="k-under-code" data-testid="tool-asked">{summary(toolKind(name), name, asked ?? {}, cwd) || JSON.stringify(asked ?? {}).slice(0, 400)}</span></Under>}
      {/* Said on the call's own line when the hook changed nothing and gave no reason. */}
      {hook.allowed !== undefined && (hook.input !== undefined || hook.allowed) && <Under name="Hook" testid="tool-hook-allowed">allowed it{hook.allowed ? `: ${hook.allowed}` : ""}</Under>}
    </div>
  );
}

// The calls that change files: only they show what a language server found.
const EDITS = new Set<ToolKind>(["edit", "write", "patch", "notebook"]);
// The calls that only look around: one that failed is a note on the page, not an alarm.
const LOOKS = new Set<ToolKind>(["read", "search", "glob", "list", "web", "fetch"]);

// What a language server found after the edit, as the model was told it: the
// server and what it says, then a row a finding.
function DiagnosticsRows({ d }: { d: ResultDiagnostics }) {
  const errors = d.lines.some((l) => l.severity === "error");
  return (
    <div className="k-under" data-testid="tool-diagnostics" data-state={errors ? "errors" : d.lines.length ? "warnings" : d.pending ? "pending" : "fixed"}>
      <Under name={d.server || "Diagnostics"} tone={errors ? "fail" : d.lines.length ? "warn" : undefined}><span data-testid="tool-diagnostics-head">{d.late ? "from an earlier edit: " : ""}{d.head}</span></Under>
      {d.lines.map((l, i) => <Under key={i} code tone={l.severity === "error" ? "fail" : "warn"} testid="tool-diagnostic"><span className="k-under-where">{l.where}</span> {l.text}</Under>)}
    </div>
  );
}

// A result that was cut names the file with all of it ("saved to <path>").
// Whether the storage retention has removed that file since: asked once per
// result that names one, so the call says what became of it.
const SAVED = /saved to:? (\/\S+?\.(?:txt|log|md))/g;
function useSpillRemoved(sessionId: string | undefined, out: string): boolean {
  const [gone, setGone] = useState(false);
  const paths = useMemo(() => [...new Set([...out.matchAll(SAVED)].map((m) => m[1]!))], [out]);
  useEffect(() => {
    if (!sessionId || !paths.length) return setGone(false);
    let live = true;
    api<{ removed: string[] }>("/api/storage/retention/removed", { method: "POST", body: JSON.stringify({ session_id: sessionId, paths }) })
      .then((r) => { if (live) setGone(r.removed.length > 0); }, () => {});
    return () => { live = false; };
  }, [sessionId, paths]);
  return gone;
}

export function ToolCall({ use: asked, result, live, sessionId, cwd, lead, auto, peek, quiet, event }: Props) {
  const hook = hookOf(result);
  // Every call shows the input that ran.
  const use = hook?.input !== undefined ? { ...asked, input: hook.input } : asked;
  // (The card stands at the same place in the tree before and after its result, with a hook's rows and
  // without: made again there, it would lose what it holds, and a card that stays open would stand empty.)
  const beside = (card: ReactNode) => <>{card}{hook && <HookRows hook={hook} asked={asked.input} name={use.name} cwd={cwd} />}</>;
  if (AGENT_TOOLS.has(use.name)) return beside(<AgentCall use={use} result={result} live={live} />);
  if (use.name === "run_code") return beside(<CodeCall use={use} result={result} live={live} sessionId={sessionId} cwd={cwd} event={event} />);
  if (use.name === "AskReaders" || use.name === "ask_readers") return beside(<ReadersCall use={use} result={result} live={live} sessionId={sessionId} cwd={cwd} />);
  const kind = toolKind(use.name);
  const input: any = use.input ?? {};
  if (kind === "ask" && !live) return beside(<QuestionCard use={use} result={result} sessionId={sessionId} />);
  const call = <GenericCall use={use} result={result} live={live} sessionId={sessionId} cwd={cwd} kind={kind} input={input} lead={lead} auto={auto} peek={peek} quiet={quiet} hook={hook} asked={asked.input} />;
  // A server asked the owner something while this call runs: a line says so under the call.
  return <AskedUnder use={use} sessionId={result ? undefined : sessionId}>{call}</AskedUnder>;
}

// A command longer than this, or of more than one line, is shown whole where the call is opened; a shorter one is all on its line.
const LINE_COMMAND = 72;
const NO_CALLS: { id: string; result?: unknown }[] = [];

function GenericCall({ use, result, live, sessionId, cwd, kind, input, lead, auto, peek, quiet, hook, asked }: Props & { kind: ToolKind; input: any; hook?: HookMark; asked?: any }) {
  const { text: out, nested, memory, diagnostics } = useMemo(() => { const m = splitMemory(resultText(result)); const d = EDITS.has(kind) ? splitDiagnostics(m.text) : { text: m.text, diagnostics: [] }; return { ...splitNested(d.text), memory: m.memory, diagnostics: d.diagnostics }; }, [result, kind]);
  const images = resultImages(result);
  const spillGone = useSpillRemoved(sessionId, out);
  const refused = useBlocked(sessionId).find((b) => b.calls?.includes(use.id));
  // With no result it runs only while its session works, and waits while its approval card is open.
  const mine = useMemo(() => (result || live ? NO_CALLS : [{ id: use.id }]), [result, live, use.id]);
  const { working, waiting } = useCallsLive(sessionId, mine);
  const marked = useMarked(sessionId, [use]);
  const marks = marked ? marksOf(sessionId, use.id) : [];
  // How it stands: a call the owner's stop or a restart ended did not fail, and neither did one that was
  // turned away before it ran, by the owner on its card or by the policy, the reviewer or the judge.
  const ended = result?.is_error ? stopKind(result.content) : undefined;
  const said = callState(result);
  const state = live ? "live" : !result ? (waiting ? "waiting" : working || !sessionId ? "running" : "unfinished")
    : refused ? "refused" : said === "error" && marks.some((m) => m.kind === "denied") ? "denied" : said;
  // Whether it was carried out, in whole or in part: its verb says it ran only then.
  const ran = state === "live" || ranOf(state, result, familyOf(use.name) === "change");
  // A call that only looks around and failed (a file that is not there) is a note, not an alarm.
  const soft = LOOKS.has(kind);
  const isShell = kind === "shell" || kind === "stdin";
  const shell = isShell ? shellStatus(out) : {};
  const plan = kind === "plan" ? planItems(use.name, input) : null;
  // Closed until asked for: its line says what it did. A command that runs is
  // open while it does, so its output shows as it arrives.
  // When it ends it stays as it stood, with the tail of its output, until it has left the view
  // (lib/held.ts): folding it then would drop every line under it. The owner's own fold lets it go.
  const [picked, pick] = useState<boolean | null>(null);
  useHeld();
  const held = !!auto && callHeld(use.id, state === "running" && !!sessionId);
  const setPicked = (to: boolean) => { pick(to); if (!to) letGo(callKey(use.id)); };
  const open = picked ?? (!!auto && kind === "shell" && !!sessionId && (state === "running" || held));
  const files = useMemo(() => (open ? callFiles(kind, use, cwd, (result as { shown?: { line?: number } } | undefined)?.shown?.line) : null), [open, kind, use, cwd, result]);
  const change = useMemo(() => (kind === "edit" || kind === "write" || kind === "patch" ? changeOf(use) : null), [kind, use]);
  // A search hit on this call or its output opens this card (not a sibling call of the same reply).
  const focused = useUI((s) => !peek && s.focusCall === use.id);
  const root = useRef<HTMLDivElement>(null);
  useLetGoUnseen(root, callKey(use.id), held);
  useEffect(() => {
    if (!focused) return;
    setPicked(true);
    setUI({ focusCall: null });
    // After the transcript has scrolled to the reply that holds it (its frame comes first).
    requestAnimationFrame(() => requestAnimationFrame(() => { root.current?.scrollIntoView({ block: "center" }); root.current?.classList.add("flash"); setTimeout(() => root.current?.classList.remove("flash"), 1600); }));
  }, [focused]);
  const rejected = plan && result?.is_error && !ended ? resultText(result) : undefined;
  // Why it failed, in a line of its own output, while the call is closed. A call that was turned away says
  // who turned it away and why: the words written for the model are not the reason.
  const why = state === "error" && !open && !rejected ? failureLine(result, cwd) : "";
  const ownReason = state === "denied" ? denialReason(resultText(result)) : "";
  const turned = state === "refused" && !refused ? refusalOf(result) : null;
  // A plan update says where the plan stands: the step in progress, and how many are done.
  const planNow = plan?.find((i) => i.status === "in_progress");
  const planDone = plan?.filter((i) => i.status === "completed").length ?? 0;
  const command = isShell ? commandText(use) : "";
  // A wait for agents says whom it waited for, by their titles, and for how long at most.
  const waits = use.name === "wait_agent";
  const waitsFor = useAuto((s) => (!waits ? "" : Array.isArray(input.targets) && input.targets.length ? input.targets.map((id: string) => s.agents[id]?.title ?? "an agent").join(", ") : "every running agent"));
  // A marked command is on its line whole, every line of it: it is never cut by the line's end.
  const isMarked = marks.length > 0 || !!hook;
  const whole = isMarked && kind === "shell";
  // (A plan update that was not applied says so as its verb, with the reason under its line: no state word, no step.)
  const what = rejected ? "" : waits ? `for ${waitsFor}, up to ${fmtWait(Number(input.timeout_ms ?? 300_000))}` : plan ? (planNow ? planNow.active ?? planNow.text : plan.length && planDone === plan.length ? "Every step done" : plan.length ? "Not started" : "No steps") : whole ? command.trim() : summary(kind, use.name, input, cwd);
  const more = kind === "shell" && !whole ? moreLines(use) : 0;
  // A check the ledger answered (src/checks): it passed on these same files before, and did not run.
  const ledger = !!(result as (ToolResultBlock & { shown?: { ledger?: boolean } }) | undefined)?.shown?.ledger;
  const words = kind === "plan" || kind === "skill" || kind === "other" || kind === "mcp" || kind === "stop";
  const verb = rejected ? "Plan update not applied" : state === "unrun" ? NOT_RUN : waits ? (state === "running" || state === "live" ? STATE_WORD.wait : ran ? "Waited" : "Wait") : LABEL[kind]?.[state === "running" || state === "live" ? 0 : ran ? 1 : 2] ?? FLEET_LABEL[use.name] ?? use.name;
  // What a change that was made, is being made or waits to be made adds and removes: one that failed or was turned away changed nothing.
  const changed = state === "ok" || state === "running" || state === "live" || state === "waiting";
  // A small change shows its lines under the closed line, as a failure shows its reason.
  const small = useMemo(() => (!open && !peek && change && changed ? smallChange(use) : null), [open, peek, change, changed, use]);
  return (
    <Collapsible.Root ref={root} open={open} onOpenChange={setPicked} className="k-tool-call group/tool" data-testid="tool-call" data-call={use.id} data-tool={use.name} data-state={state} data-kind={kind} data-marked={isMarked ? "" : undefined} data-soft={soft ? "" : undefined} data-auto={picked === null ? "" : undefined}>
      <Collapsible.Trigger className="k-line" title={isShell && input.description ? `The model's note: ${input.description}` : undefined}>
        {/* The line's words, as one run of text: the verb, how it stands, why it is marked, what it was made on.
            A marked call's words wrap, so what it was made on is whole on the page. */}
        <span className="k-line-text" data-wrap={isMarked ? "" : undefined}>
          <span className="k-line-verb">{ledger ? "Not run" : verb}</span>{" "}
          {ledger && <><span className="k-line-state" data-tone="idle" data-testid="call-ledger" title="It passed on these same files before: the answer is from the check ledger.">passed before, same files</span>{" "}</>}
          {state === "waiting" && <><span className="k-line-state" data-tone="need" data-testid="call-state">{NEEDS_APPROVAL}</span>{" "}</>}
          {state === "error" && !rejected && <><span className="k-line-state" data-tone={soft ? "note" : "fail"} data-testid="call-state">{noSuchTool(result) ? "no such tool" : shell.exit !== undefined ? `exit ${shell.exit}` : "failed"}</span>{" "}</>}
          {state === "denied" && <><span className="k-line-state" data-tone="own" data-testid="call-state">denied by you</span>{" "}</>}
          {state === "refused" && <><span className="k-line-state" data-tone="warn" data-testid="tool-refused">{turned?.by === "Hook" ? "blocked by a hook" : "refused"}</span>{" "}</>}
          {ended && <><span className="k-line-state" data-tone={ended === "cut" ? "warn" : "idle"} data-testid="tool-ended" title={ended === "cut" ? "A daemon restart cut this call. It may have partly run." : stoppedByUser(result?.content) ? "You stopped the turn while this call ran." : resultText(result)}>{ended === "cut" ? "cut by a restart" : CALL_STOPPED}</span>{" "}</>}
          {state === "unfinished" && <><span className="k-line-state" data-tone="idle" data-testid="call-state" title="The turn ended before this call had a result.">no result</span>{" "}</>}
          {state === "unrun" && <><span className="k-line-state" data-tone="idle" data-testid="call-state" title={resultText(result)}>{notRun(result?.content)}</span>{" "}</>}
          {/* Why it is marked, in a few words; the sentence is its title and stands in the opened call. */}
          {!quiet && marks.filter((m) => m.kind !== "denied").map((m) => <Fragment key={m.kind}><span className="k-line-state k-line-mark" data-tone="warn" data-testid="call-mark" data-mark={m.kind} title={m.why}>{m.short}</span>{" "}</Fragment>)}
          {hook?.input !== undefined && <><span className="k-line-state k-line-mark" data-tone="warn" data-testid="tool-rewritten">changed by a hook</span>{" "}</>}
          {hook?.allowed !== undefined && hook.input === undefined && <><span className="k-line-state k-line-mark" data-tone="warn" title="A hook of yours allowed it without asking you.">allowed by a hook</span>{" "}</>}
          <span className="k-line-what" data-words={words ? "" : undefined} data-whole={whole ? "" : undefined}>{what}</span>
        </span>
        <span className="k-line-end">
          {(more > 0 || (plan && plan.length > 0) || (change && changed) || nested.length > 0 || shell.background || shell.session) && <Apart />}
          {/* The lines of a command after its first: at the line's end, where nothing cuts it. */}
          {more > 0 && <span className="k-line-rest" data-testid="more-lines">+{more} {more === 1 ? "line" : "lines"}</span>}
          <MachineBadge sessionId={sessionId} callId={use.id} />
          {plan && plan.length > 0 && !rejected && <span className="k-line-plan" data-testid="plan-count"><Pips done={planDone} total={plan.length} />{planDone}/{plan.length}</span>}
          {change && changed && (change.added > 0 || change.removed > 0) && <Delta added={change.added} removed={change.removed} />}
          {nested.length > 0 && <span className="k-line-chip" data-testid="tool-nested" title={nested.map((n) => n.path).join("\n")}>+ {nested.length === 1 ? shortPath(nested[0]!.path, cwd) : `${nested.length} instruction files`}</span>}
          {shell.background && <span className="k-line-chip" data-testid="tool-background">background</span>}
          {shell.session && <span className="k-line-chip">session {shell.session}</span>}
          {lead && <ThoughtMark />}
          {(state === "running" || state === "live") && <span className="k-line-run" aria-label="running" />}
        </span>
      </Collapsible.Trigger>
      {(why || rejected || ownReason || turned || (refused && sessionId)) && (
        <div className="k-under">
          {why && <Under code tone={soft ? "note" : "fail"} testid="tool-why">{why}</Under>}
          {rejected && <Under tone="fail" testid="plan-rejected">{rejected} The plan before it stays.</Under>}
          {/* The owner's own words with their denial; none given, none shown. */}
          {ownReason && <Under name="You" testid="tool-denial">{ownReason}</Under>}
          {turned && <Under name={turned.by} testid="tool-refusal">{shortPaths(turned.why, cwd)}</Under>}
          {refused && sessionId && (
            // Who refused it and why, once, and the retry the owner can let through.
            <Under name={refused.by === "reviewer" ? "Reviewer" : refused.by === "streak" ? "Keel" : "Judge"} testid="tool-refusal" act={refused.retry
              ? <span className="k-under-act" data-testid="tool-retry-allowed">Retry allowed</span>
              : <button type="button" data-testid="tool-retry" onClick={() => allowRetry(sessionId, refused.id)} className="k-under-act k-out-link"><RotateCcw className="size-3" /> Allow one retry</button>}>
              {refused.by === "unavailable" ? "could not review it: " : refused.by === "streak" ? "refused it after repeated refusals: " : ""}{refused.reason}
            </Under>
          )}
        </div>
      )}
      {small && (
        <div className="k-line-change" data-testid="small-change" aria-hidden="true">
          {small.map((l, i) => <div key={i} data-kind={l.t === "+" ? "add" : "del"}><span>{l.t}</span>{l.text || " "}</div>)}
        </div>
      )}
      {hook && <HookRows hook={hook} asked={asked} name={use.name} cwd={cwd} />}
      {diagnostics.map((d, i) => <DiagnosticsRows key={i} d={d} />)}
      <Collapsible.Panel className="k-tool-panel overflow-hidden">
        <div className="k-tool-body">
          {marks.length > 0 && <p className="k-mark-why" data-testid="mark-why">{marks.map((m) => m.why).join(" ")}</p>}
          {lead}
          {/* (A stop's or a restart's words are written for the model, not printed by the command.) */}
          {isShell && <Terminal name={use.name} input={input} command={command} whole={whole} out={ended && !String(result?.content ?? "").startsWith(RESTART_RAN) ? "" : out} running={state === "running"} held={held && picked === null && !shell.background} failed={state === "error"} sessionId={sessionId} callId={use.id} quiet={result ? quietEnd(result.content) : undefined} />}
          {plan && plan.length > 0 && <div className={rejected ? "opacity-60" : undefined}><PlanCard items={plan} explanation={input.explanation} /></div>}
          {files && (
            <CallDiff files={files} actions={(f) => (
              <>
                {kind === "write" && typeof input.content === "string" && <CopyButton text={String(input.content)} label="Copy the content" testid="copy-content" />}
                {(f as CallFile).full && <CopyButton text={(f as CallFile).full!} label={`Copy the path ${(f as CallFile).full}`} testid="copy-path" icon={<Link2 />} />}
              </>
            )} />
          )}
          {!files && pathOf(input) && !isShell && (
            <Copyable text={pathOf(input)!} label="Copy the path" testid="copy-path" className="k-tool-path">
              <span className="block truncate py-0.5 pr-9 font-mono text-caption text-faint" title={pathOf(input)}>{shortPath(pathOf(input)!, cwd)}</span>
            </Copyable>
          )}
          {!files && !isShell && !plan && !live && kind === "other" && (
            <Copyable text={JSON.stringify(input, null, 2)} label="Copy the input" testid="copy-input">
              <pre className="k-out max-h-64 text-faint">{JSON.stringify(input, null, 2).slice(0, 4000)}</pre>
            </Copyable>
          )}
          {!isShell && !plan && out && (!files || state === "error") && (
            <Copyable text={out} label="Copy the output" testid="copy-output">
              <pre className={cn("k-out max-h-80", result?.is_error && !ended ? "text-danger" : "text-muted")}>{out}</pre>
            </Copyable>
          )}
          {spillGone && <p className="text-caption text-faint" data-testid="spill-removed">The full output this result names was removed by the storage retention. Run the command again to get it.</p>}
          {nested.map((n) => (
            <details key={n.path} className="rounded-md border border-line bg-sunken" data-testid="nested-instructions">
              <summary className="cursor-pointer px-2.5 py-1.5 text-caption text-muted">Instructions loaded: <span className="font-mono">{shortPath(n.path, cwd)}</span></summary>
              <pre className="max-h-64 overflow-auto border-t border-line p-2.5 font-mono text-caption leading-relaxed whitespace-pre-wrap break-words text-muted">{n.body}</pre>
            </details>
          ))}
          {memory.map((m, i) => (
            <details key={i} className="rounded-md border border-line bg-sunken" data-testid="tool-memory">
              <summary className="flex cursor-pointer items-center gap-1.5 px-2.5 py-1.5 text-caption text-muted"><Brain className="size-3.5 text-faint" />Memory from {m.source}<span className="text-faint">, {m.hook}</span></summary>
              <pre className="max-h-64 overflow-auto border-t border-line p-2.5 font-mono text-caption leading-relaxed whitespace-pre-wrap break-words text-muted">{m.body}</pre>
            </details>
          ))}
          {images.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {images.map((im, i) => <img key={i} src={`data:${im.media_type};base64,${im.data}`} className="max-h-64 rounded-lg border border-line" alt="" />)}
            </div>
          )}
        </div>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

// Paths in a line of output as the call's own line names them: under the session's folder, else from the home folder.

// A plan's steps as marks: the done ones filled.
function Pips({ done, total }: { done: number; total: number }) {
  if (total > 12) return null;
  return <span className="k-pips" aria-hidden="true">{Array.from({ length: total }, (_, i) => <i key={i} data-done={i < done ? "" : undefined} />)}</span>;
}

// Lines added and removed, as every diff's head says them.
export function Delta({ added, removed }: { added: number; removed: number }) {
  return <span className="k-delta"><span className="text-ok">+{added}</span> <span className="text-danger">-{removed}</span></span>;
}

// The change a call made, as the lines of a diff: the same block Changes and
// Review show. `start`: the line of the file an edit began at, when the tool said so.
const WRITE_SHOWN = 800;
function callFiles(kind: ToolKind, use: ToolUseBlock, cwd?: string, start?: number): CallFile[] | null {
  const input: any = use.input ?? {};
  const { added, removed } = changeOf(use);
  const path = typeof input.file_path === "string" ? input.file_path : "";
  if (kind === "edit" && typeof input.old_string === "string" && typeof input.new_string === "string") {
    // Numbered when the tool said where in the file the text was: a number counted from the snippet's start would name the wrong line.
    let o = start ?? 0, n = start ?? 0;
    const no = (v: number) => (start === undefined ? undefined : v);
    const lines: PatchLine[] = diffLines(splitLines(input.old_string), splitLines(input.new_string)).map((op) =>
      op.t === "+" ? { kind: "add", text: op.line, new: no(n++) } : op.t === "-" ? { kind: "del", text: op.line, old: no(o++) } : { kind: "ctx", text: op.line, old: no(o++), new: no(n++) });
    return [{ path: shortPath(path, cwd), full: path, status: "M", added, removed, lines }];
  }
  if (kind === "write" && typeof input.content === "string") {
    const all = splitLines(input.content);
    const lines: PatchLine[] = all.slice(0, WRITE_SHOWN).map((text, i) => ({ kind: "add", text, new: i + 1 }));
    if (all.length > WRITE_SHOWN) lines.push({ kind: "hunk", text: `${all.length - WRITE_SHOWN} more lines` });
    return [{ path: shortPath(path, cwd), full: path, status: "A", added, removed, lines }];
  }
  if (kind === "patch") {
    return patchFiles(patchText(input)).map((f) => {
      let o = 1, n = 1;
      const known = f.op !== "update"; // a hunk of an update names its place by its context, not by a line number
      const lines: PatchLine[] = f.lines.map((l) =>
        l.startsWith("@@") ? { kind: "hunk", text: l }
          : l[0] === "+" ? { kind: "add", text: l.slice(1), new: known ? n++ : undefined }
          : l[0] === "-" ? { kind: "del", text: l.slice(1), old: known ? o++ : undefined }
          : { kind: "ctx", text: l.slice(1), old: known ? o++ : undefined, new: known ? n++ : undefined });
      return {
        path: f.moveTo ? `${shortPath(f.path, cwd)} → ${shortPath(f.moveTo, cwd)}` : shortPath(f.path, cwd), full: f.moveTo ?? f.path, status: f.op === "add" ? "A" : f.op === "delete" ? "D" : "M",
        added: lines.filter((l) => l.kind === "add").length, removed: lines.filter((l) => l.kind === "del").length, lines,
      };
    });
  }
  return null;
}

// Where a result was cut to fit: the command's whole output is in its log.
const TOO_LARGE = /^Output too large \(([\d.]+ ?KB)\)\. Full output saved to: \S+\n\nPreview \(first ([\d.]+ ?KB)\):\n([\s\S]*?)\n\.\.\.\n?([\s\S]*)$/;
const CUT = /\n\n\[\.\.\. (\d+) (?:characters|chars) cut[^\]]*\]\n\n/;

// The output of a command, in the program's own colors (a test run's red and green): a failed
// command's passing lines are not red. The command stands above it only where the call's line
// cannot hold it (several lines, or a long one); `whole`: the line shows all of it already.
// `held`: the command has ended and its card stays as it stood: the tail of the output it was following.
// (Not a command that was moved to the background: its result says so, and that is what its card shows.)
// `quiet`: what the output says when the call has ended and printed nothing (who stopped it, if anyone did).
// `failed`: the command failed: its output opens at the first line that says the error, not at its start or its end.
function Terminal({ name, input, command, whole: onLine, out, running, held, failed, sessionId, callId, quiet = "No output." }: { name: string; input: any; command: string; whole: boolean; out: string; running?: boolean; held?: boolean; failed?: boolean; sessionId?: string; callId?: string; quiet?: string }) {
  const body = shellBody(name, out).trimEnd();
  const big = TOO_LARGE.exec(body);
  const cut = big ? null : CUT.exec(body);
  const shown = big ? big[3]! : body;
  const [whole, setWhole] = useState(false);
  const box = useRef<HTMLPreElement>(null);
  useLayoutEffect(() => { if (failed && box.current) scrollToError(box.current); }, [failed, shown]);
  const above = !!command && !onLine && (command.includes("\n") || command.length > LINE_COMMAND);
  return (
    <div className="k-terminal k-copyable overflow-hidden rounded-md border border-line bg-code font-mono text-caption leading-relaxed" data-testid="terminal">
      {above && (
        <Copyable text={command} label="Copy the command" testid="copy-command">
          <pre className="border-b border-line px-2.5 py-2 pr-9 whitespace-pre-wrap break-all text-fg" data-testid="terminal-command">
            <span className="select-none text-accent-ink">$ </span>{command}
          </pre>
        </Copyable>
      )}
      {name === "write_stdin" && input.chars && <pre className="border-b border-line px-2.5 py-1.5 text-accent-ink">{JSON.stringify(input.chars)}</pre>}
      {/* A held call goes on showing what its follower showed; one whose follower never got a line shows its result. */}
      {(running || (held && !!callId && !!tails.get(callId)?.text)) && sessionId && callId ? <CallLog sessionId={sessionId} callId={callId} follow ended={!running} failed={failed} quiet={quiet} />
        : whole && sessionId && callId ? <CallLog sessionId={sessionId} callId={callId} onLeave={() => setWhole(false)} />
        : shown ? (
          <Copyable text={() => stripAnsiText(shown)} label="Copy the output" testid="copy-output">
            {cut ? (
              <pre ref={box} className="max-h-80 overflow-auto px-2.5 py-2 pr-16 whitespace-pre-wrap break-all text-muted">
                <Ansi text={shown.slice(0, cut.index)} />
                <span className="k-out-gap" data-testid="output-gap">{Number(cut[1]).toLocaleString("en-US")} characters not shown here</span>
                <Ansi text={shown.slice(cut.index + cut[0].length)} />
              </pre>
            ) : <pre ref={box} className="max-h-80 overflow-auto px-2.5 py-2 pr-16 whitespace-pre-wrap break-all text-muted"><Ansi text={shown} /></pre>}
          </Copyable>
        ) : !running && <p className="px-2.5 py-2 pr-16 font-sans text-faint" data-testid="no-output">{quiet}</p>}
      {/* The command is on the call's line: its copy button stands with the output's. */}
      {!above && command && <CopyButton text={command} label="Copy the command" testid="copy-command" icon={<SquareTerminal />} className="k-copy-corner k-copy-second" />}
      {(big || cut) && !whole && !running && !held && (
        <div className="k-out-more" data-testid="output-more">
          <span>{big ? `The first ${big[2]} of ${big[1]} of output.` : "The start and the end of a long output."}</span>
          {sessionId && callId && <button type="button" data-testid="output-whole" onClick={() => setWhole(true)} className="k-out-link">Show the whole output</button>}
        </div>
      )}
      {big?.[4]?.trim() && <pre className="border-t border-line px-2.5 py-1.5 whitespace-pre-wrap break-all text-faint">{big[4].trim()}</pre>}
    </div>
  );
}

// The output of a call's command from its log: followed while it runs (the
// newest part, as the Terminal pane keeps it), or read from its start a part
// at a time. Followed only while the page is in view: a log that is not there
// yet is asked for less and less often, and any other failure is said once and
// ends the following (the result has the output when the command ends).
// `none`: no command of the call has started yet (a follower's answer).
type LogPart = { text: string; from: number; to: number; size: number; running?: boolean; job?: string; none?: boolean };
const POLL_MS = 1000, POLL_MAX_MS = 15_000;
// What a follower has shown of a call's output, and how far it has read, by call.
const tails = new Map<string, { text: string; at: number }>();
// `ended`: the command a follower follows has ended: it reads what is left once and asks no more.
// `quiet`: what a follower says once the command has ended with nothing printed.
// `failed`: the command it followed has failed: the box goes from the end to the first line that says the error, when one does.
function CallLog({ sessionId, callId, follow, ended, failed, onLeave, quiet }: { sessionId: string; callId: string; follow?: boolean; ended?: boolean; failed?: boolean; onLeave?: () => void; quiet?: string }) {
  const over = useRef(false);
  over.current = !!ended;
  // (A follower starts from what was followed of this call before: the call is drawn by more than one
  // component in its life, a step of one call and then of several, and its card must not stand empty between.)
  const [text, setText] = useState(follow ? tails.get(callId)?.text ?? "" : "");
  const [part, setPart] = useState<{ from: number; to: number; size: number; before: number[] } | null>(null);
  const [gone, setGone] = useState(false);
  const pre = useRef<HTMLPreElement>(null);
  const job = useRef<string | null>(null);
  const read = (from: number) => api<LogPart>(job.current ? `/api/sessions/${sessionId}/terminal/${job.current}/log?from=${from}` : `/api/sessions/${sessionId}/terminal/call/${encodeURIComponent(callId)}/log?from=${from}${follow ? "&follow=1" : ""}`)
    .then((r) => { if (r.job) job.current = r.job; return r; });
  useEffect(() => {
    let stop = false;
    let t: Timer | undefined;
    if (!follow) {
      read(0).then((r) => { if (!stop) { setText(r.text); setPart({ ...r, before: [] }); } }).catch((e) => ((e as { status?: number }).status === 404 ? setGone(true) : reportError(e, { at: "call log" })));
      return () => { stop = true; };
    }
    let at = tails.get(callId)?.at ?? 0, wait = POLL_MS;
    const pull = async () => {
      t = undefined;
      // Not while the page is hidden: it goes on when the page shows again.
      if (document.hidden) return;
      try {
        // Caught up in a few reads; far behind, the newest part is what a follower shows.
        for (let n = 0; !stop && n < 8; n++) {
          const r = await read(at);
          // No command of this call yet: asked again later, each time later.
          if (r.none) { wait = Math.min(wait * 2, POLL_MAX_MS); break; }
          wait = POLL_MS;
          if (r.to > at) {
            const add = r.text, to = r.to;
            setText((m) => { const next = bounded(m + add, 64 * 1024).text; if (tails.size > 24) tails.clear(); tails.set(callId, { text: next, at: to }); return next; });
            at = r.to;
          }
          if (r.to >= r.size) break;
          if (n === 7) at = Math.max(at, r.size - 32 * 1024);
        }
      } catch (e) {
        // No command of this call yet (it has not started, or it is not a command of this machine): asked again later, each time later.
        if ((e as { status?: number }).status === 404) wait = Math.min(wait * 2, POLL_MAX_MS);
        else { reportError(e, { at: "call log" }); return; }
      }
      if (!stop && !over.current) t = setTimeout(pull, wait);
    };
    const shown = () => { if (!document.hidden && !stop && t === undefined) t = setTimeout(pull, 0); };
    document.addEventListener("visibilitychange", shown);
    t = setTimeout(pull, 150);
    return () => { stop = true; clearTimeout(t); document.removeEventListener("visibilitychange", shown); };
  }, [sessionId, callId, follow]);
  useLayoutEffect(() => {
    const p = pre.current;
    if (!p || !follow) return;
    if (!(ended && failed && scrollToError(p))) p.scrollTop = p.scrollHeight;
  }, [text, follow, ended, failed]);
  const go = (from: number, before: number[]) => read(from).then((r) => { setText(r.text); setPart({ ...r, before }); if (pre.current) pre.current.scrollTop = 0; }).catch((e) => reportError(e, { at: "call log" }));
  if (gone) return <p className="k-out-more" data-testid="output-gone"><span>The command's log is no longer kept.</span>{onLeave && <button type="button" onClick={onLeave} className="k-out-link">Back</button>}</p>;
  return (
    <>
      {part && (
        <div className="k-out-more" data-testid="output-log-bar">
          <span className="tabular-nums">The whole output, {part.from.toLocaleString("en-US")} to {part.to.toLocaleString("en-US")} of {part.size.toLocaleString("en-US")} bytes</span>
          {part.before.length > 0 && <button type="button" data-testid="output-prev" className="k-out-link" onClick={() => go(part.before.at(-1)!, part.before.slice(0, -1))}>Earlier part</button>}
          {part.to < part.size && <button type="button" data-testid="output-next" className="k-out-link" onClick={() => go(part.to, [...part.before, part.from])}>Next part</button>}
          {onLeave && <button type="button" data-testid="output-leave" className="k-out-link" onClick={onLeave}>Show less</button>}
        </div>
      )}
      <pre ref={pre} data-testid={follow ? "live-output" : "whole-output"} aria-live={follow ? "off" : undefined} className={cn("overflow-auto px-2.5 py-2 pr-9 whitespace-pre-wrap break-all text-muted", follow ? "max-h-56" : "max-h-96")}>
        {text ? <Ansi text={text} /> : <span className="text-faint">{follow ? (ended ? quiet ?? "No output." : "No output yet.") : part ? "Nothing here." : "Reading the log."}</span>}
      </pre>
    </>
  );
}

// The steps of a plan, as a list: under a plan update's line in the conversation, and in the strip above the message box.
// `live`: the list is the plan as it stands now (the strip): the step in progress pulses.
export function PlanCard({ items, explanation, live }: { items: PlanItem[]; explanation?: string; live?: boolean }) {
  return (
    <div className="k-plan px-3 py-2" data-testid="plan">
      {explanation && <p className="mb-2 text-caption text-muted">{explanation}</p>}
      <ul className="flex flex-col gap-1">
        {items.map((it, i) => (
          <li key={i} className="flex items-start gap-2 text-ui leading-snug" data-status={it.status}>
            <span className="mt-0.5 shrink-0">
              {it.status === "completed" ? <Check className="size-3.5 text-ok" />
                : it.status === "in_progress" ? <CircleDot className={cn("size-3.5 text-accent-ink", live && "animate-pulse-dot")} />
                : it.status === "cancelled" ? <X className="size-3.5 text-faint" />
                : <Circle className="size-3.5 text-faint" />}
            </span>
            <span className={cn(
              it.status === "completed" && "text-muted line-through decoration-line-strong",
              it.status === "in_progress" && "font-medium text-fg",
              it.status === "cancelled" && "text-faint line-through",
              it.status === "pending" && "text-fg/85",
            )}>{it.status === "in_progress" && it.active ? it.active : it.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
