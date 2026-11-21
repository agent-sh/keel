// The owner's agent view: the one program Keel reaches other harnesses'
// sessions through (Claude Code, Codex, agy). Keel calls its verbs and nothing
// else: `list -a --json` for the rows (it already covers the machines it links),
// `rpc` (one JSON request on stdin, one JSON reply) to read a screen or a
// prompt, answer a prompt, read a session's identity and queue a message, and
// `hosts rpc NAME JSON` for the same on a linked machine. Keel never types into
// a terminal or opens a harness's socket itself: the agent view owns how a
// message lands and when a session is ready for one.
//
// Which program: `agent_view` in <config>/drive.json. Keel names none of its
// own; without it no outside session is listed and the list says why.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "../providers/config.ts";
import { writeOwnFile } from "../core/ownfile.ts";
import { readText } from "../core/proc.ts";

export const KINDS = ["claude", "codex", "agy"] as const;
export type Raw = Record<string, any>;

const file = () => join(configDir(), "drive.json");

export function settings(): { agent_view?: string } {
  try {
    return JSON.parse(readFileSync(file(), "utf8")) ?? {};
  } catch {
    return {};
  }
}

export function setAgentView(path: string | null) {
  const next = { ...settings(), agent_view: path?.trim() || undefined };
  writeOwnFile(file(), JSON.stringify(next, null, 2) + "\n");
}

export function program(): string {
  const p = settings().agent_view?.trim();
  if (!p) throw new Error(`no agent view is set: name its program as agent_view in ${file()} (or in Settings, Sessions elsewhere)`);
  if (!existsSync(p)) throw new Error(`the agent view ${p} does not exist`);
  return p;
}

// A linked machine's agent view answers over ssh with its own connect
// timeout; this bound is the one that ends a call that still hangs.
const LIMIT_MS = 60_000;

async function run(args: string[], stdin?: string, signal?: AbortSignal): Promise<string> {
  const prog = program();
  const proc = Bun.spawn([prog, ...args], { stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin), stdout: "pipe", stderr: "pipe" });
  const kill = () => proc.kill();
  const timer = setTimeout(kill, LIMIT_MS);
  signal?.addEventListener("abort", kill, { once: true });
  try {
    const [out, err, code] = await Promise.all([readText(proc.stdout), readText(proc.stderr), proc.exited]);
    if (signal?.aborted) throw new Error("the call was stopped");
    if (code !== 0) {
      const line = err.split("\n").map((l) => l.trim()).filter(Boolean).pop();
      throw new Error(`agent view ${args[0]} failed (exit ${code})${line ? `: ${line}` : ""}`);
    }
    return out;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", kill);
  }
}

export async function list(signal?: AbortSignal): Promise<Raw[]> {
  const out = await run(["list", "-a", "--json"], undefined, signal);
  let v: unknown;
  try {
    v = JSON.parse(out);
  } catch (e) {
    throw new Error(`agent view list printed no JSON (${(e as Error).message})`);
  }
  if (!Array.isArray(v)) throw new Error("agent view list did not print a JSON list");
  return v as Raw[];
}

// One rpc to the machine that holds the session (host empty: this one).
export async function rpc(host: string, request: Record<string, unknown>, signal?: AbortSignal): Promise<any> {
  const body = JSON.stringify(request);
  const out = host ? await run(["hosts", "rpc", host, body], undefined, signal) : await run(["rpc"], body, signal);
  let reply: any;
  try {
    reply = JSON.parse(out.trim());
  } catch (e) {
    throw new Error(`agent view rpc printed no JSON (${(e as Error).message})`);
  }
  if (host) return reply; // `hosts rpc` prints the far result itself and fails on an error
  if (reply?.ok === true) return reply.result;
  throw new Error(String(reply?.error ?? "agent view rpc failed"));
}

// The agent view's own key of a row: the first of job, thread, session, pane, name.
export const nativeKey = (r: Raw): string => ["job", "thread", "session", "pane", "name"].map((k) => r[k]).find((v) => typeof v === "string" && v) ?? "";

// Keel's id of an outside session: <kind>:<key> here, <kind>:<host>::<key> on a linked machine.
export function rowId(r: Raw): string {
  const kind = r.tool || "agent";
  return r.host ? `${kind}:${r.host}::${nativeKey(r)}` : `${kind}:${nativeKey(r)}`;
}

export function parseId(id: string): { kind: string; host: string; key: string } | null {
  const i = id.indexOf(":");
  if (i < 0) return null;
  const kind = id.slice(0, i);
  const rest = id.slice(i + 1);
  if (!(KINDS as readonly string[]).includes(kind) || !rest) return null;
  const j = rest.indexOf("::");
  return j < 0 ? { kind, host: "", key: rest } : { kind, host: rest.slice(0, j), key: rest.slice(j + 2) };
}
