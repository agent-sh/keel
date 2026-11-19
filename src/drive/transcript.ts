// The newest turns of another harness's transcript: Claude Code's session JSONL
// and Codex's rollout JSONL, read from the file the agent view names. A turn is
// what a reader needs to follow the session: the prompts, the replies, and one
// line per tool call. Thinking, request blobs and bookkeeping records are left out.
import { openSync, readSync, closeSync, fstatSync } from "node:fs";

export type Turn = { role: "user" | "assistant" | "tool"; text: string; at?: number };

const TAIL_BYTES = 512 * 1024;

export function readTail(path: string, bytes = TAIL_BYTES): string[] {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString("utf8").split("\n");
    if (start > 0) lines.shift(); // a partial first record
    return lines.filter((l) => l.trim());
  } finally {
    closeSync(fd);
  }
}

const oneLine = (s: string, n: number) => {
  const l = s.replace(/\s+/g, " ").trim();
  return l.length > n ? l.slice(0, n - 1) + "…" : l;
};

function toolLine(name: string, input: unknown): string {
  const i = (typeof input === "string" ? safeJson(input) : input) as any;
  const arg = i && typeof i === "object" ? (i.command ?? i.cmd ?? i.file_path ?? i.path ?? i.pattern ?? i.url ?? i.query ?? i.description) : i;
  const shown = Array.isArray(arg) ? arg.join(" ") : typeof arg === "string" ? arg : arg === undefined ? "" : JSON.stringify(arg);
  return `${name}${shown ? ` ${oneLine(shown, 200)}` : ""}`;
}

const safeJson = (s: string) => {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
};

const time = (t: unknown) => (typeof t === "string" ? Date.parse(t) || undefined : undefined);

// A harness's own context it puts in a user turn (environment, AGENTS.md,
// system reminders) is not something the owner or a model said.
const injected = (s: string) => /^\s*<(environment_context|user_instructions|system-reminder|local-command|command-name|permissions instructions)/.test(s) || /^# AGENTS\.md instructions/.test(s);

export function claudeTurns(lines: string[]): Turn[] {
  const out: Turn[] = [];
  for (const l of lines) {
    const r = safeJson(l) as any;
    if (!r || (r.type !== "user" && r.type !== "assistant") || r.isSidechain || r.isMeta) continue;
    const at = time(r.timestamp);
    const c = r.message?.content;
    if (typeof c === "string") {
      if (!injected(c)) out.push({ role: r.type, text: c, at });
      continue;
    }
    if (!Array.isArray(c)) continue;
    for (const b of c) {
      if (b?.type === "text" && b.text && !injected(b.text)) out.push({ role: r.type, text: b.text, at });
      else if (b?.type === "tool_use") out.push({ role: "tool", text: toolLine(b.name, b.input), at });
    }
  }
  return out;
}

export function codexTurns(lines: string[]): Turn[] {
  const out: Turn[] = [];
  for (const l of lines) {
    const r = safeJson(l) as any;
    if (r?.type !== "response_item") continue;
    const p = r.payload ?? {};
    const at = time(r.timestamp);
    if (p.type === "message" && (p.role === "user" || p.role === "assistant")) {
      // Each part on its own: the harness's context in one part leaves the owner's words in another.
      const text = (p.content ?? []).map((x: any) => String(x?.text ?? "")).filter((t: string) => t.trim() && !injected(t)).join("\n").trim();
      if (text) out.push({ role: p.role, text, at });
    } else if (p.type === "function_call" || p.type === "custom_tool_call") {
      out.push({ role: "tool", text: toolLine(p.name, p.arguments ?? p.input), at });
    }
  }
  return out;
}

export function turnsOf(kind: string, path: string): Turn[] {
  const lines = readTail(path);
  return kind === "codex" ? codexTurns(lines) : claudeTurns(lines);
}

// The newest turns as text within `budget` characters; older turns go first and
// the text says how many were left out.
export function fitTurns(turns: Turn[], budget: number): string {
  const label = { user: "user", assistant: "assistant", tool: "  tool" } as const;
  const rendered = turns.map((t) => `${label[t.role]}: ${t.role === "tool" ? t.text : t.text.trim()}`);
  const kept: string[] = [];
  let size = 0;
  for (let i = rendered.length - 1; i >= 0; i--) {
    const r = rendered[i]!;
    if (size + r.length + 1 > budget) {
      if (!kept.length) kept.push(r.slice(0, Math.max(0, budget - 40)) + " [... cut]");
      break;
    }
    size += r.length + 1;
    kept.push(r);
  }
  kept.reverse();
  const left = rendered.length - kept.length;
  return (left > 0 ? `(${left} earlier entries not shown; this read's budget was reached)\n` : "") + kept.join("\n");
}
