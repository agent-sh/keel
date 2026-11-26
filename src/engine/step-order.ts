// The order of the calls of one reply. They start together, which is right for calls that do not meet. A call
// that only reads, after a call that can write (a command, an edit, a tool that acts outside Keel) in the same
// reply, is the model's next step in the same message: a command that makes a file and the read of that file.
// Run at once, the read found no file. It starts when the calls before it that can write have ended.
// A command after an edit in the same reply waits for the edit too: it names the file the edit makes (a cat, a
// build, a chmod of it) and ran beside the edit, with the edit not yet written. Commands do not wait for each
// other, nor an edit for a command: independent calls overlap as they always did.
import type { ToolUseBlock } from "../core/types.ts";
import type { Tool } from "../tools/types.ts";

// Whether a tool's call may change what a later read finds: not a read, and not a tool that acts only on what Keel
// keeps (a wait, an agent, a question), which a read does not see.
export const writes = (t: Pick<Tool, "readOnly" | "kind"> | undefined): boolean =>
  !!t && !t.readOnly && (t.kind === undefined || t.kind === "shell" || t.kind === "edit");

export class StepOrder {
  private before: Promise<unknown>[] = [];
  private edits: Promise<unknown>[] = [];
  constructor(private tools: readonly Pick<Tool, "name" | "readOnly" | "kind">[], private signal: AbortSignal) {}

  // `start` begins the call at once, with `ordered`: a promise a local read awaits before its gate (so the gate
  // sees the files the earlier calls left), and other calls await before running the tool. It settles when those
  // earlier calls end or the turn stops (the call then answers the stop itself).
  run<T>(u: Pick<ToolUseBlock, "name">, start: (ordered: () => Promise<void>) => Promise<T>): Promise<T> {
    const tool = this.tools.find((t) => t.name === u.name);
    // A read comes after every call that can write; a command, after the edits.
    const ahead = (tool?.readOnly ? this.before : tool?.kind === "shell" ? this.edits : []).slice();
    const ordered = (): Promise<void> => {
      if (!ahead.length || this.signal.aborted) return Promise.resolve();
      let release = () => {};
      const stopped = new Promise<void>((r) => { release = r; this.signal.addEventListener("abort", release, { once: true }); });
      return Promise.race([Promise.allSettled(ahead), stopped]).finally(() => this.signal.removeEventListener("abort", release)).then(() => {});
    };
    const run = start(ordered);
    // (A command that waits is a write the reads after it wait for, from the moment it was asked for.)
    if (writes(tool)) {
      const done = run.then(() => {}, () => {});
      this.before.push(done);
      if (tool?.kind === "edit") this.edits.push(done);
    }
    return run;
  }
}
