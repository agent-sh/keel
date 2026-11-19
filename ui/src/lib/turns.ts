// Turn and session-tree commands: slash commands, palette actions and the
// fork button under prompts and replies.
import { createElement } from "react";
import { GitBranch } from "lucide-react";
import { rowActions, slash } from "./extend.ts";
import { chooseFallback, setFallback } from "../components/Fallback.tsx";
import { fuzzy, registerCommand } from "./keys.ts";
import { actions, getState, reportError } from "./store.ts";
import { getUI, navigate } from "./ui.ts";

const current = () => {
  const r = getUI().route;
  return r.name === "session" ? getState().sessions[r.id] : undefined;
};
const fork = (id: string, eventId: string) => actions.fork(id, eventId).then((s) => navigate({ name: "session", id: s.id }));
const efforts = (model: string) => getState().models.find((m) => m.id === model)?.efforts ?? [];

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
  { id: "fork", label: "Fork this session into a new one", when: ({ session }) => !!session?.head, run: (_a, { session }) => fork(session!.id, session!.head!) },
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
  { id: "continue", label: "Continue the stopped turn", when: ({ session }) => !!session && session.phase !== "working", run: (_a, { session }) => actions.resume(session!.id).then(() => {}) },
  {
    id: "fallback",
    label: "The model a declined request goes on with",
    hint: "[model | off]",
    when: ({ session }) => !!session,
    run: (arg, { session }) => {
      if (!arg) return chooseFallback(session!.id);
      if (arg === "off" || arg === "none") return setFallback(session!.id, null).then(() => {});
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
  { id: "fallback", label: "Set a fallback model for declined requests", group: "Session", words: "refusal declined backup model", when: () => !!current(), run: () => chooseFallback(current()!.id) },
  { id: "continue", label: "Continue the stopped turn", group: "Session", words: "resume", when: () => !!current() && current()!.phase !== "working", run: () => actions.resume(current()!.id).catch(reportError) },
);

rowActions.add(
  { id: "fork", label: "Fork a new session from here", icon: createElement(GitBranch, { className: "size-3.5" }), on: "user", run: (e, s) => void fork(s.id, e.id).catch(reportError) },
  { id: "fork-reply", label: "Fork a new session from here", icon: createElement(GitBranch, { className: "size-3.5" }), on: "assistant", run: (e, s) => void fork(s.id, e.id).catch(reportError) },
);
