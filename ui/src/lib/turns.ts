// Turn and session-tree commands: slash commands, palette actions and the
// fork button under prompts and replies.
import { createElement } from "react";
import { GitBranch, GitFork, Split, Undo2 } from "lucide-react";
import { shownAsPrompt } from "../../../src/core/owner.ts";
import { rowActions, slash } from "./extend.ts";
import { chooseFallback, setFallback } from "../components/Fallback.tsx";
import { fuzzy, registerCommand } from "./keys.ts";
import { actions, getState, reportError, ensureModels } from "./store.ts";
import { getUI } from "./ui.ts";
import { openPlaced } from "./looks.ts";

const current = () => {
  const r = getUI().route;
  return r.name === "session" ? getState().sessions[r.id] : undefined;
};
// (The fork takes the pane of the session it was made from: the owner means to work in it. lib/looks.ts)
const fork = (id: string, eventId: string, opts: { before?: boolean; title?: string; worktree?: boolean } = {}) => actions.fork(id, eventId, opts).then((s) => openPlaced(s.id, id));
const efforts = (model: string) => getState().models.find((m) => m.id === model)?.efforts ?? [];

// The chat, the files or both go back to before a prompt (components/RewindDialog.tsx).
const rewind = (id: string, eventId?: string) => void import("../components/RewindDialog.tsx").then((m) => m.openRewind({ sessionId: id, eventId }));

slash.add(
  {
    id: "compact",
    label: "Summarize the history to free context",
    hint: "[what to keep]",
    run: (arg, { session }) => {
      if (!session) throw new Error("Compaction works on an open session.");
      return actions.compact(session.id, arg || undefined).then(() => {});
    },
  },
  // `/fork -w [name]` (or --worktree): the fork works in a worktree of its own.
  {
    id: "fork",
    label: "Fork this session into a new one",
    hint: "[-w] [name]",
    when: ({ session }) => !!session?.head,
    run: (a, { session }) => {
      const w = /^(?:-w|--worktree)(?:\s+|$)/.exec(a);
      return fork(session!.id, session!.head!, { title: w ? a.slice(w[0].length).trim() : a, worktree: !!w });
    },
  },
  {
    id: "effort",
    label: "Set the reasoning effort",
    hint: "<level>",
    when: ({ session }) => !!session && efforts(session.model).length > 0,
    run: (arg, { session }) => {
      const list = efforts(session!.model);
      if (!list.includes(arg)) throw new Error(`This model takes: ${list.join(", ")}.`);
      return actions.patch(session!.id, { settings: { effort: arg } }).then(() => {});
    },
  },
  { id: "resume", label: "Resume the stopped turn", when: ({ session }) => !!session && session.phase !== "working", run: (_a, { session }) => actions.resume(session!.id).then(() => {}) },
  // The name it had before the act was called Resume: typed from habit, it does the same.
  { id: "continue", label: "Resume the stopped turn (the same as /resume)", when: ({ session }) => !!session && session.phase !== "working", run: (_a, { session }) => actions.resume(session!.id).then(() => {}) },
  {
    id: "fallback",
    label: "The model a declined or overloaded request goes on with",
    hint: "[model | off]",
    when: ({ session }) => !!session,
    run: async (arg, { session }) => {
      if (!arg) return chooseFallback(session!.id);
      if (arg === "off" || arg === "none") return setFallback(session!.id, null).then(() => {});
      await ensureModels(); // a name is looked for in the whole listing
      const best = getState().models.map((m) => ({ m, s: fuzzy(arg, `${m.name} ${m.id}`) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s)[0];
      if (!best) throw new Error(`No listed model matches "${arg}".`);
      return setFallback(session!.id, best.m.id).then(() => {});
    },
  },
);

registerCommand(
  { id: "compact", label: "Compact the context", group: "Session", words: "summarize summary free tokens", when: () => !!current(), run: () => actions.compact(current()!.id).catch(reportError) },
  { id: "clear-context", label: "Clear the context, keep the session", group: "Session", words: "fresh reset", when: () => !!current(), run: () => actions.clear(current()!.id).catch(reportError) },
  { id: "fork", label: "Fork this session", group: "Session", words: "branch copy", when: () => !!current()?.head, run: () => fork(current()!.id, current()!.head!).catch(reportError) },
  { id: "fork-worktree", label: "Fork this session into a new worktree", group: "Session", words: "branch copy folder checkout", when: () => !!current()?.head, run: () => fork(current()!.id, current()!.head!, { worktree: true }).catch(reportError) },
  { id: "fallback", label: "Set a fallback model for declined or overloaded requests", group: "Session", words: "refusal declined overloaded capacity backup model", when: () => !!current(), run: () => chooseFallback(current()!.id) },
  { id: "continue", label: "Resume the stopped turn", group: "Session", words: "continue go on", when: () => !!current() && current()!.phase !== "working", run: () => actions.resume(current()!.id).catch(reportError) },
);

rowActions.add(
  { id: "rewind", label: "Rewind to before this prompt", icon: createElement(Undo2, { className: "size-3.5" }), on: "user", idle: true, when: (e) => shownAsPrompt(e), run: (e, s) => rewind(s.id, e.id) },
  { id: "fork", label: "Fork a new session from here", icon: createElement(GitBranch, { className: "size-3.5" }), on: "user", run: (e, s) => void fork(s.id, e.id).catch(reportError) },
  // The prompt itself stays out of the copy and waits in the new box, with its attachments, to be changed.
  { id: "fork-before", label: "Fork before this prompt and edit it there", icon: createElement(Split, { className: "size-3.5" }), on: "user", run: (e, s) => void fork(s.id, e.id, { before: true }).catch(reportError) },
  { id: "fork-reply", label: "Fork a new session from here", icon: createElement(GitBranch, { className: "size-3.5" }), on: "assistant", run: (e, s) => void fork(s.id, e.id).catch(reportError) },
  // A worktree of its own: two forks of one task never write the same folder.
  { id: "fork-worktree", label: "Fork into a new worktree from here", icon: createElement(GitFork, { className: "size-3.5" }), on: "user", run: (e, s) => void fork(s.id, e.id, { worktree: true }).catch(reportError) },
  { id: "fork-reply-worktree", label: "Fork into a new worktree from here", icon: createElement(GitFork, { className: "size-3.5" }), on: "assistant", run: (e, s) => void fork(s.id, e.id, { worktree: true }).catch(reportError) },
);
