// An ACP agent's own process runs in the same sandbox as Keel's commands
// (bwrap in a systemd scope, the session's profile and network), so what it
// does outside ACP (its own shell, its own file access) is held to the same
// limits as the requests Keel judges. It keeps its own folders writable: an
// agent writes its sessions, logs and caches under home (opencode in the XDG
// folders, Kimi in ~/.kimi-code, Claude Code in ~/.claude and ~/.claude.json, Codex
// in ~/.codex, Gemini in ~/.gemini), and npx or uvx their package caches.
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { confine, sandboxStatus } from "../safety/sandbox.ts";
import type { SessionPerm } from "../safety/gate.ts";
import type { AcpAgent } from "./agents.ts";

// Harness names whose folders an agent of that id (or program) writes.
const HARNESSES = ["opencode", "kimi", "claude", "codex", "gemini", "qwen", "goose", "cursor", "augment", "auggie", "crush", "droid", "factory"];

// The folders under home the agent may write: its own (by id, program name and
// the harness it is), each where it already exists; the XDG data and state
// folders are made for an agent named here so a first run can write them.
export function agentFolders(agent: Pick<AcpAgent, "id" | "run">, make = true, home = homedir()): string[] {
  const prog = agent.run ? basename(agent.run.command) : "";
  const args = agent.run?.args.join(" ") ?? "";
  const names = new Set([agent.id, prog, ...HARNESSES.filter((h) => `${agent.id} ${prog} ${args}`.toLowerCase().includes(h))].filter((n) => n && !["npx", "uvx", "node", "bun", "python", "python3"].includes(n)));
  const out: string[] = [];
  let dots: string[] = [];
  try { dots = readdirSync(home).filter((f) => f.startsWith(".")); } catch {}
  for (const n of names) {
    // ~/.<name>, and its variants (~/.kimi-code, ~/.claude.json).
    for (const f of dots) if (f === `.${n}` || f.startsWith(`.${n}-`) || f.startsWith(`.${n}_`) || f.startsWith(`.${n}.`)) out.push(join(home, f));
    out.push(join(home, ".config", n), join(home, ".cache", n));
    for (const xdg of [join(home, ".local", "share", n), join(home, ".local", "state", n)]) {
      if (make && HARNESSES.includes(n)) try { mkdirSync(xdg, { recursive: true }); } catch {}
      out.push(xdg);
    }
  }
  if (prog === "npx") out.push(join(home, ".npm"));
  if (prog === "uvx") out.push(join(home, ".cache", "uv"), join(home, ".local", "share", "uv"));
  return [...new Set(out)].filter((p) => existsSync(p));
}

export type AgentConfinement = { argv: string[]; confined: boolean; note: string; writable: string[] };

// How the agent of a session starts, and the plain words for its card.
// `start`: the agent starts now (its folders are made); else only described.
export function confineAgent(agent: AcpAgent, perm: Pick<SessionPerm, "sandbox" | "network">, workspace: string, start = true): AgentConfinement {
  const argv = [agent.run!.command, ...agent.run!.args];
  const st = sandboxStatus();
  if (perm.sandbox === "off") return { argv, confined: false, writable: [], note: `${agent.name} runs unconfined: the sandbox is off for it, so its own shell and file access are not limited (only what it asks Keel for is judged).` };
  if (!st.available) return { argv, confined: false, writable: [], note: `${agent.name} runs unconfined: ${st.reason}.` };
  const writable = agentFolders(agent, start);
  const where = perm.sandbox === "workspace-write" ? "it writes only in the workspace and its own folders" : "it writes only in its own folders";
  return {
    argv: confine(argv, perm, workspace, writable),
    confined: true,
    writable,
    note: `${agent.name} runs in the command sandbox (${perm.sandbox}): ${where}${perm.network ? "" : ", with no network (its model service included)"}.`,
  };
}
