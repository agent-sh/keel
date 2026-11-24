// The rules as a replay runs them (src/safety/trial.ts): one stored call, the facts of its session as plain data,
// the policy's own decision. Nothing here reads the store or the daemon: a developer's trial of a patch
// (`keel safety trial --patch`, in the command's own process, never the daemon's) loads this file from a patched
// copy of the source, so what it reaches is the candidate's rules. A module of the rules says, in RULE_MODULES, the pure function the replay reaches it by
// (trial-conventions.test.ts holds every module to it).
import { contains } from "../core/paths.ts";
import { parseNamespaces } from "./accounts.ts";
import { credentialAt, placesOf } from "./credentials.ts";
import { isTextMark, lasting, looking } from "./looked.ts";
import { classOf, type MarkMcp, type MarkTool } from "./marks.ts";
import { decide, type Facts, type Mode, type Rule } from "./policy.ts";
import type { Shared } from "./shared-branches.ts";
import { shimmedPrograms } from "./shell.ts";
import { judgedOf, type Judged, type Ruled } from "./trial.ts";

// The modules a rule lives in and the pure function of each the replay reaches (through decide).
export const RULE_MODULES: { file: string; fn: string; what: string }[] = [
  { file: "policy.ts", fn: "decide", what: "the decision on a call: modes, grants, owner-only files, the classes below" },
  { file: "risk.ts", fn: "risksAt", what: "what a command line risks: destroys, remote, exposes, hidden, machine" },
  { file: "risk-words.ts", fn: "unwrap", what: "the words of the risk classes: wrappers, shells, interpreters, what leaves the machine" },
  { file: "shell.ts", fn: "splitCommand", what: "a command line as its commands, and which of them only read" },
  { file: "accounts.ts", fn: "writesOf", what: "a write with the owner's accounts, and whose namespace it goes to" },
  { file: "credentials.ts", fn: "credentialAt", what: "where the owner's credentials are kept" },
  { file: "credential-reads.ts", fn: "shellCredentialReads", what: "a command's reads of credentials" },
  { file: "shared-branches.ts", fn: "sharedRefusal", what: "an agent's worktree guard of the branches it shares" },
  { file: "autonomy.ts", fn: "neverAllowed", what: "the commands that never run without the owner" },
  { file: "marks.ts", fn: "classOf", what: "a stored call as the gate classes it" },
];

// A session's facts, as the read thread gathers them (trial-read.ts).
export type SessionFacts = {
  id: string; workspace: string; scope: { workspace: string; scratch: string[] }; agent: boolean; machine: boolean; mode: Mode; sandboxed: boolean;
  // Where a call ran, by its id (the records its commands left).
  folders: Map<string, string>;
  // An agent in a worktree Keel made: what it shares with the other checkouts (shared-branches.ts), as git says now.
  shared?: Shared;
};
// What every session shares: the owner's home, Keel's own folders, the tools and MCP tools as known now.
export type CommonFacts = {
  home: string; state: string; config: string[]; bins: (root: string) => string[]; shell?: string;
  tools: Map<string, MarkTool>; mcp: MarkMcp[]; runCode: string; mcpCall: string;
};
export type ReplayCall = { id: string; name: string; input: unknown; ruled?: Ruled };
// `mode`: the mode the call is judged in. `namespaces`: the owner's, as he wrote them. `rules`: the standing rules
// that held for the call. `now`: the disk's lasting answers (git remotes, manifests) read for this trial.
// `texts`: the files the call's decision read, read again now, where they hash as its record says.
export type ReplayRules = { mode: Mode; namespaces: string[]; rules: Rule[]; now?: Map<string, unknown>; texts?: [string, string][] };
// `missed`: questions of the disk the call's record has no answer for; `shims`: whether a program name is a
// version manager's shim was asked, with no record of it.
export type Replayed = { judged: Judged; kind: string; missed: string[]; shims: boolean };

const parsed = new Map<string, ReturnType<typeof parseNamespaces>>();
const namesOf = (list: string[]) => {
  const key = list.join("\n");
  let n = parsed.get(key);
  if (!n) { if (parsed.size > 64) parsed.clear(); parsed.set(key, (n = parseNamespaces(list))); }
  return n;
};

// One call, decided by the rules as the gate decides it (gate.ts evaluate), from what is stored of it.
export function replayCall(u: ReplayCall, s: SessionFacts, c: CommonFacts, r: ReplayRules): Replayed {
  const { cls, name } = classOf({ id: u.id, name: u.name, input: u.input }, { workspace: s.workspace, mcp: c.mcp, runCode: c.runCode, mcpCall: c.mcpCall, shell: c.shell }, c.tools, s.folders);
  // (A file's text is kept as its hash: the text comes in `texts`, or the question stays not answered.)
  const seed = (u.ruled?.looked ?? []).filter(([, v]) => !isTextMark(v));
  const l = looking(s.scope.workspace, [...seed, ...(r.now ?? []), ...(r.texts ?? [])], () => false);
  const real = u.ruled?.real;
  const shims = !real && cls.kind === "shell" && !s.machine && cls.interpreter === undefined && shimmedPrograms(cls.command).length > 0;
  const scratch = u.ruled?.named?.length ? [...s.scope.scratch, ...u.ruled.named] : s.scope.scratch;
  const edit = cls.kind === "edit";
  const places = placesOf(c.home, { state: c.state, ...(c.config[0] ? { config: c.config[0] } : {}) });
  const worktrees = `${c.state}/worktrees`;
  const f: Facts = {
    mode: r.mode, workspace: edit || !s.machine ? s.scope.workspace : s.workspace, sandboxed: s.sandboxed, rules: r.rules, tool: name, scratch,
    looked: l.view(), ...(real ? { real: (p: string) => real[p] === true } : {}),
    accounts: { names: namesOf(r.namespaces), ...(s.agent ? { agent: true as const } : {}) },
    ...(s.agent ? { agent: true as const } : {}),
    ...(s.shared && (cls.kind === "shell" || cls.kind === "edit") ? { shared: s.shared } : {}),
    ...(s.machine ? {} : {
      credential: (p: string) => credentialAt(p, places),
      own: () => ({ home: c.home, config: c.config, bins: c.bins(s.scope.workspace), land: (x: string) => [x] }),
      ...(cls.kind === "read" ? {} : {
        // Keel's own files, by where they are named (the gate also follows links and hard links on the disk).
        keel: (p: string) => contains(c.state, p) && !scratch.some((d) => contains(d, p)) && !(contains(worktrees, s.scope.workspace) && s.scope.workspace !== worktrees && contains(s.scope.workspace, p))
          ? `it changes ${p}, one of Keel's own files (its store, its token and keys, other sessions' files)` : null,
        keelConfig: (p: string) => c.config.some((d) => contains(d, p)) ? `it changes ${p}, which Keel runs or reads its configuration from (its hooks and their scripts, MCP servers, skills and agents), outside any sandbox` : null,
      }),
    }),
  };
  const d = decide(cls, f);
  return { judged: judgedOf(d), kind: cls.kind, missed: l.missed(), shims };
}

// Of the questions a replay could not answer, those a look now answers as it would have then.
export const lastingOf = (missed: string[]) => missed.filter(lasting);
