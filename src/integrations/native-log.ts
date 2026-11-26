// What the model's native memory did in Keel's sessions, kept without content for the daily sweep
// (src/helper/sweep.ts): a row each time a session's prompt carried it (`loaded`, with the bytes of
// its block), and each time a tool call read or wrote a file of it (`read`, `wrote`, with the
// file's path). A path is the model's own label for a memory and holds no more than that.
import { join, resolve } from "node:path";
import type { Store } from "../core/store.ts";
import type { Session, ToolResultBlock } from "../core/types.ts";
import { familyOf } from "../providers/family.ts";
import { memoryOver } from "../automation/agent-memory.ts";
import { nativeContext, nativePlaces, type Native } from "../engine/native-memory.ts";
import { targetsOf } from "../engine/nested.ts";
import type { Tool } from "../tools/types.ts";
import { readFileSync } from "node:fs";
import { memoryMeter } from "./memory-meter.ts";

export const KEEP_MS = 90 * 86_400_000;
export type NativeSystem = "claude" | "codex";
// looked: a shell command named the folder but no file it read can be told (a pipe, a listing): no read, no bytes.
export type NativeAction = "loaded" | "read" | "wrote" | "looked";

export class NativeLog {
  constructor(private store: Store) {
    store.migrate(`CREATE TABLE IF NOT EXISTS native_memory_log (
  id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, ts INTEGER NOT NULL, system TEXT NOT NULL, action TEXT NOT NULL, file TEXT NOT NULL DEFAULT '', bytes INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS native_memory_log_ts ON native_memory_log(ts);`);
  }

  note(sessionId: string, system: NativeSystem, action: NativeAction, file = "", bytes = 0, ts = Date.now()) {
    try { this.store.db.query("INSERT INTO native_memory_log (session_id, ts, system, action, file, bytes) VALUES (?, ?, ?, ?, ?, ?)").run(sessionId, ts, system, action, file.slice(0, 200), bytes); } catch {}
  }

  prune(now = Date.now()) {
    this.store.db.query("DELETE FROM native_memory_log WHERE ts < ?").run(now - KEEP_MS);
  }

  // A call of the session's tool that touched a file of its native memory: noted, and for a write
  // that left the Claude index past what a start reads, what to tell the model with the result.
  // `onRead`: told once for a call that read it, with the bytes the call's result carried (the memory meter's row).
  onRead?: (sessionId: string, bytes: number) => void;

  after(s: Session, tool: Pick<Tool, "name" | "kind">, input: unknown, result: Pick<ToolResultBlock, "is_error" | "content">): string | undefined {
    if (s.parent_id || s.machine || result.is_error) return undefined;
    const family = familyOf(s.model);
    const places = nativePlaces(family, s.workspace);
    if (!places.read.length) return undefined;
    const system: NativeSystem = family === "gpt" ? "codex" : "claude";
    const edit = tool.kind === "edit";
    const text = JSON.stringify(input ?? "");
    let over: string | undefined;
    let read = false;
    for (const dir of places.read) {
      const paths = targetsOf(tool, input, s.workspace).paths.map((p) => resolve(p)).filter((p) => p === dir || p.startsWith(`${dir}/`));
      if (!paths.length) {
        // A shell command naming the folder is a look at it: what it read cannot be told, so it carries no read.
        if (tool.kind === "shell" && text.includes(dir)) this.note(s.id, system, "looked");
        continue;
      }
      const write = places.write.some((w) => w === dir || paths.some((p) => p.startsWith(`${w}/`)));
      for (const p of paths) this.note(s.id, system, edit && write ? "wrote" : "read", p === dir ? "" : p);
      if (!(edit && write)) read = true;
      if (system === "claude" && edit && paths.includes(join(dir, "MEMORY.md"))) {
        try { over = memoryOver(readFileSync(join(dir, "MEMORY.md"), "utf8")); } catch {}
      }
    }
    if (read) try { this.onRead?.(s.id, resultBytes(result.content)); } catch {}
    return over;
  }
}

// The bytes of a result's text (an image or a file it holds is not counted).
const resultBytes = (c: ToolResultBlock["content"]): number =>
  typeof c === "string" ? Buffer.byteLength(c) : c.reduce((n, b) => n + (b.type === "text" ? Buffer.byteLength(b.text) : 0), 0);

const logs = new WeakMap<Store, NativeLog>();
export function nativeLog(store: Store): NativeLog {
  let l = logs.get(store);
  if (!l) logs.set(store, (l = new NativeLog(store)));
  return l;
}

// Each load of a session's prompt is a row.
export function wireNativeLog(store: Store, tacit: (s: Session) => boolean) {
  const log = nativeLog(store);
  nativeContext.store = tacit;
  log.onRead = (id, bytes) => void memoryMeter(store).record(id, "native_read", { outcome: "added", bytes });
  nativeContext.loaded = (s: Session, n: Native) => log.note(s.id, n.system, "loaded", n.dir, Buffer.byteLength(n.text));
}
