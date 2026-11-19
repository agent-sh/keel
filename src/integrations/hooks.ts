// The owner's hook commands at fixed points of a session, in the shape Claude
// Code and Codex share: { "hooks": { "<Event>": [{ "matcher": "<regex>",
// "hooks": [{ "type": "command", "command", "timeout"?, "onFailure"? }] }] } }.
// The owner's file (~/.config/keel-bun/hooks.json) always runs; a
// repository's .keel/hooks.json runs only once the owner pinned exactly that
// content and the content of every file under .keel/ its commands run (a
// changed file or script runs nothing until pinned again). A pin belongs to
// the repository (its git common dir), so its worktrees keep it.
//
// What a hook can do: block a call or a prompt, send a call to the owner, add
// context for the model (with the call's result; after the prompt), keep a turn
// going (Stop). What it cannot: allow anything.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { contains } from "../core/paths.ts";
import type { Store } from "../core/store.ts";
import type { Session } from "../core/types.ts";
import { tacitToolCall } from "./tacit.ts";
import { configDir } from "../providers/config.ts";

export const EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "PreCompact"] as const;
export type HookEvent = (typeof EVENTS)[number];
type Handler = { type: "command"; command: string; timeout?: number; onFailure?: "block" | "continue" };
type Group = { matcher?: string; hooks: Handler[] };

// `covers`: the files under .keel/ the pin covers besides hooks.json (what its commands run).
export type Source = { path: string; scope: "owner" | "project"; root: string; text: string; sha256: string; active: boolean; events: Record<string, number>; problems: string[]; covers: string[]; groups: Partial<Record<HookEvent, Group[]>> };

export const ownerHooksPath = () => process.env.KEEL_HOOKS ?? join(configDir(), "hooks.json");

const sha = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");

// The repository root of a folder (where .keel/ lives), else the folder.
export function projectRoot(cwd: string): string {
  for (let d = cwd; ; d = dirname(d)) {
    if (existsSync(join(d, ".git")) || existsSync(join(d, ".keel"))) return d;
    if (dirname(d) === d) return cwd;
  }
}

// The files under <root>/.keel/ that hook commands name (a script, or a folder
// of them): each named file, the rest of the folder it sits in when that is a
// folder of .keel/ (what it sources), and every file under a named folder.
const COVER_MAX = 500;
export function coveredFiles(root: string, groups: Partial<Record<HookEvent, Group[]>>): string[] {
  const keel = join(root, ".keel");
  const out = new Set<string>();
  const walk = (d: string) => {
    let names: string[] = [];
    try { names = readdirSync(d); } catch { return; }
    for (const n of names) {
      if (out.size >= COVER_MAX) return;
      const p = join(d, n);
      try { if (statSync(p).isDirectory()) walk(p); else out.add(p); } catch {}
    }
  };
  for (const list of Object.values(groups)) for (const g of list ?? []) for (const h of g.hooks) {
    for (const m of h.command.matchAll(/\.keel\/([\w./@+-]+)/g)) {
      const p = resolve(keel, m[1]!.replace(/\/+$/, ""));
      if (!contains(keel, p) || p === keel || p === join(keel, "hooks.json")) continue;
      let st;
      try { st = statSync(p); } catch { out.add(p); continue; } // a missing script is covered as missing
      if (st.isDirectory()) walk(p);
      else {
        out.add(p);
        if (dirname(p) !== keel) walk(dirname(p));
      }
    }
  }
  out.delete(join(keel, "hooks.json"));
  return [...out].sort();
}

// The digest a pin holds: hooks.json alone when its commands run no file of
// .keel/, else with each covered file's path and content.
function pinDigest(text: string, root: string, files: string[]): string {
  if (!files.length) return sha(text);
  const h = new Bun.CryptoHasher("sha256").update(text);
  for (const f of files) {
    let body = "\u0000missing";
    try { body = sha(readFileSync(f, "utf8")); } catch {}
    h.update(`\u0000${relative(root, f)}\u0000${body}`);
  }
  return h.digest("hex");
}

// A repository's pins are kept for its git common dir (a worktree's are its
// main checkout's), else for the folder.
const pinKeys = new Map<string, string>();
export function pinKey(root: string): string {
  const hit = pinKeys.get(root);
  if (hit) return hit;
  const r = Bun.spawnSync(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: root, stdout: "pipe", stderr: "ignore" });
  const out = r.success ? r.stdout.toString().trim() : "";
  const key = out ? (out.endsWith("/.git") ? dirname(out) : out) : root;
  pinKeys.set(root, key);
  return key;
}

export function parseHooks(text: string): { groups: Partial<Record<HookEvent, Group[]>>; problems: string[] } {
  const problems: string[] = [];
  const groups: Partial<Record<HookEvent, Group[]>> = {};
  let raw: any;
  try { raw = JSON.parse(text); } catch (e) { return { groups, problems: [`not JSON: ${(e as Error).message}`] }; }
  for (const [event, list] of Object.entries<any>(raw?.hooks ?? {})) {
    if (!(EVENTS as readonly string[]).includes(event)) { problems.push(`${event}: not an event Keel runs`); continue; }
    if (!Array.isArray(list)) { problems.push(`${event}: must be a list`); continue; }
    const out: Group[] = [];
    for (const g of list) {
      if (g?.matcher !== undefined) {
        try { new RegExp(g.matcher); } catch { problems.push(`${event}: matcher ${g.matcher} is not a regular expression`); continue; }
      }
      const hooks = (Array.isArray(g?.hooks) ? g.hooks : []).filter((h: any) => {
        if (h?.type === "command" && typeof h.command === "string" && h.command.trim()) return true;
        problems.push(`${event}: only command hooks run here (${h?.type ?? "no type"})`);
        return false;
      });
      if (hooks.length) out.push({ matcher: g.matcher, hooks });
    }
    if (out.length) groups[event as HookEvent] = out;
  }
  return { groups, problems };
}

// A tool's own name and the names other harnesses give it, for hook matchers
// and agents' disallowed tools. `via` is the tool that dispatched it (mcp_call
// runs a catalog tool by its full name; Claude Code calls that mcp__<name>).
// A tool that runs a command (a monitor of one, a program, a command on
// another machine) also answers to Bash.
export function namesOf(tool: string, input: any, via?: string): string[] {
  const out = [tool];
  const t = tacitToolCall(tool, input);
  if (t) out.push(t.tool_name);
  if (via && via !== tool) out.push(via);
  if (via === "mcp_call" && !tool.startsWith("mcp__")) out.push(`mcp__${tool}`);
  if (/^(run_code|keel__run_on)$/.test(tool) || (/^monitor$/i.test(tool) && input?.command)) out.push("Bash");
  if (/^(edit|replace|multi_edit|multiedit|apply_patch)$/i.test(tool)) out.push("Edit");
  if (/^(write|write_file)$/i.test(tool)) out.push("Write");
  return [...new Set(out)];
}

export type HookResult = { block?: string; ask?: string; context: string[]; continueWith?: string };

export class Hooks {
  constructor(private store: Store) {
    store.migrate("CREATE TABLE IF NOT EXISTS hook_pins (root TEXT NOT NULL, sha256 TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY (root));");
  }

  private pinned(root: string) {
    return this.store.db.query<{ sha256: string }, [string]>("SELECT sha256 FROM hook_pins WHERE root = ?").get(pinKey(root))?.sha256;
  }

  sources(cwd: string): Source[] {
    const out: Source[] = [];
    const read = (path: string, scope: "owner" | "project") => {
      if (!existsSync(path)) return;
      let text = "";
      try { text = readFileSync(path, "utf8"); } catch (e) { out.push({ path, scope, root: projectRoot(cwd), text: "", sha256: "", active: false, events: {}, problems: [(e as Error).message], covers: [], groups: {} }); return; }
      const { groups, problems } = parseHooks(text);
      const root = projectRoot(cwd);
      const files = scope === "project" ? coveredFiles(root, groups) : [];
      const digest = pinDigest(text, root, files);
      let active = true;
      if (scope === "project") {
        const pin = this.pinned(projectRoot(cwd));
        if (!pin) { active = false; problems.unshift("not pinned: the owner reads the file and pins it before it runs"); }
        else if (pin !== digest) { active = false; problems.unshift(`changed since it was pinned${files.length ? " (the file or a script it runs)" : ""}: pin it again to run it`); }
      }
      const events = Object.fromEntries(Object.entries(groups).map(([e, g]) => [e, g!.reduce((n, x) => n + x.hooks.length, 0)]));
      out.push({ path, scope, root, text: text.slice(0, 20_000), sha256: digest, active, events, problems, covers: files.map((f) => relative(root, f)), groups });
    };
    read(ownerHooksPath(), "owner");
    read(join(projectRoot(cwd), ".keel", "hooks.json"), "project");
    return out;
  }

  pin(cwd: string, digest: string): string | null {
    const project = this.sources(cwd).find((s) => s.scope === "project");
    if (!project) return "this folder has no .keel/hooks.json";
    if (project.sha256 !== digest) return "the file is no longer the one that was shown: read it again";
    this.store.db.query("INSERT INTO hook_pins (root, sha256, created) VALUES (?, ?, ?) ON CONFLICT(root) DO UPDATE SET sha256 = excluded.sha256, created = excluded.created").run(pinKey(projectRoot(cwd)), digest, Date.now());
    return null;
  }

  // Every active handler of an event that matches, run at the same time.
  async run(event: HookEvent, s: Session, payload: Record<string, unknown>, match?: string[]): Promise<HookResult> {
    const handlers: Handler[] = [];
    for (const src of this.sources(s.workspace)) {
      if (!src.active) continue;
      for (const g of src.groups[event] ?? []) {
        if (match && g.matcher && g.matcher !== "*" && !match.some((n) => new RegExp(`^(?:${g.matcher})$`).test(n))) continue;
        handlers.push(...g.hooks);
      }
    }
    const res: HookResult = { context: [] };
    if (!handlers.length) return res;
    const input = JSON.stringify({ session_id: s.id, cwd: s.workspace, hook_event_name: event, model: s.model, ...payload });
    const outs = await Promise.all(handlers.map((h) => runHook(h, input, s.workspace, (h.timeout ?? (event === "UserPromptSubmit" ? 30 : 600)) * 1000)));
    for (const [i, o] of outs.entries()) {
      const h = handlers[i]!;
      const fails = (why: string) => { if (h.onFailure === "block") res.block ??= `a hook failed (${why})`; };
      if (o.code === null) { fails("it did not finish in time"); continue; }
      if (o.code === 2) { res.block ??= o.stderr.trim() || "a hook blocked this"; continue; }
      if (o.code !== 0) { fails(`exit ${o.code}`); continue; }
      const text = o.stdout.trim();
      if (!text) continue;
      let j: any;
      try { j = JSON.parse(text); } catch {
        if (event === "PreToolUse" || event === "UserPromptSubmit") { if (!text.startsWith("{")) { res.context.push(text); continue; } res.block ??= "a hook answered JSON that cannot be read"; }
        else res.context.push(text);
        continue;
      }
      const hso = j.hookSpecificOutput ?? {};
      if (j.decision === "block") {
        if (event === "Stop") res.continueWith ??= String(j.reason ?? "a hook asked to go on");
        else res.block ??= String(j.reason ?? "a hook blocked this");
      }
      if (j.continue === false && event !== "Stop") res.block ??= String(j.stopReason ?? "a hook stopped this");
      if (hso.permissionDecision === "deny") res.block ??= String(hso.permissionDecisionReason ?? "a hook denied this call");
      else if (hso.permissionDecision === "ask") res.ask ??= String(hso.permissionDecisionReason ?? "a hook asks the owner about this call");
      // "allow" is ignored: a hook cannot allow anything. A rewrite is not supported.
      if (hso.updatedInput !== undefined) res.block ??= "a hook tried to change the call's input, which Keel does not do";
      if (typeof hso.additionalContext === "string" && hso.additionalContext.trim()) res.context.push(hso.additionalContext.trim().slice(0, 10_000));
      if (typeof j.systemMessage === "string" && j.systemMessage.trim()) res.context.push(j.systemMessage.trim().slice(0, 10_000));
    }
    return res;
  }
}

async function runHook(h: Handler, input: string, cwd: string, ms: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  let p: ReturnType<typeof Bun.spawn>;
  try {
    p = Bun.spawn(["bash", "-c", h.command], { cwd, stdin: Buffer.from(input), stdout: "pipe", stderr: "pipe", detached: true, env: { ...process.env, KEEL_PROJECT_DIR: cwd, CLAUDE_PROJECT_DIR: cwd } });
  } catch (e) {
    return { code: -1, stdout: "", stderr: (e as Error).message };
  }
  let timedOut = false;
  const t = setTimeout(() => { timedOut = true; try { process.kill(-p.pid, "SIGKILL"); } catch {} }, ms);
  const read = async (s: ReadableStream<Uint8Array>) => {
    const r = s.getReader();
    const parts: Uint8Array[] = [];
    try { for (;;) { const { done, value } = await r.read(); if (done) break; parts.push(value); } } catch {}
    return Buffer.concat(parts).toString("utf8");
  };
  const [stdout, stderr, code] = await Promise.all([read(p.stdout as ReadableStream<Uint8Array>), read(p.stderr as ReadableStream<Uint8Array>), p.exited]);
  clearTimeout(t);
  return { code: timedOut ? null : code, stdout, stderr };
}

export const hookContext = (event: string, lines: string[]) => `<hook event="${event}">\n${lines.join("\n\n")}\n</hook>`;
