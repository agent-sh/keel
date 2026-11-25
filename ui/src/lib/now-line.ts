// The bottom line of the dock (components/DockNow.tsx): what the session's turn is doing now, in the daemon's words
// for it, with a marker that says which kind of moment it is, and the place the work happens. Pure decisions only.
import type { SessionState } from "./watch.ts";

// The three moments a live turn is in, plus the one that calls the owner. The words are the state vocabulary's
// (src/core/state-words.ts): a marker never says them alone, it is also read out as one of them.
//   thinking: the model is on its way to an answer (the request, its first bytes, a stream that went quiet)
//   acting:   a tool runs, or the harness works on the context
//   waiting:  nothing of the turn runs: a wait, a held or retried request, agents or a command that go on without it
//   need:     the owner is asked for something
export type Moment = "thinking" | "acting" | "waiting" | "need";

const THINKING = new Set(["model", "turn", "stalled"]);
const ACTING = new Set(["tool", "compacting"]);

// Null for a session at rest (done, idle, failed, stopped, declined): it has no moment.
export function momentOf(st: Pick<SessionState, "watch" | "why">): Moment | null {
  if (st.watch === "need") return "need";
  if (st.watch === "wait" || st.watch === "resume") return "waiting";
  if (st.watch !== "work") return null;
  if (ACTING.has(st.why ?? "")) return "acting";
  // (A session at work with no reason of a turn is one whose turn ended: its agents go on.)
  return THINKING.has(st.why ?? "") ? "thinking" : "waiting";
}

// The verbs of a call that names a file or a folder (src/core/tool-line.ts): the words after one are its path.
const FILE_VERB = /^(Reading|Editing|Writing|Patching|Listing) (\S.*?)(?:, and \d+ more)?$/;

// The file an action names, relative to the session's folder: "Editing src/a.ts" is src/a.ts. Nothing for a
// command, a search or a path outside the folder (the Files panel reads the folder only), and nothing for several
// calls at once (which one would it be).
export function pathInAction(text: string, workspace: string): { before: string; path: string; rel: string; dir: boolean } | null {
  const m = FILE_VERB.exec(text.trim());
  if (!m || /, and \d+ more$/.test(text.trim())) return null;
  const path = m[2]!;
  const rel = relIn(workspace, path);
  if (rel === null) return null;
  return { before: `${m[1]} `, path, rel, dir: m[1] === "Listing" };
}

// A path as a place in the folder: relative stays, absolute inside the folder is made relative, anything else is outside.
export function relIn(workspace: string, path: string): string | null {
  if (path.startsWith("~") || path.split("/").includes("..")) return null;
  const root = workspace.replace(/\/+$/, "");
  if (path === root) return "";
  if (path.startsWith(`${root}/`)) return path.slice(root.length + 1);
  return path.startsWith("/") ? null : path.replace(/^\.\//, "");
}
