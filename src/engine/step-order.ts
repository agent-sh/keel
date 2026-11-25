// The order of the calls of one reply. They start together, which is right for calls that do not meet. A call
// that only reads, after a call that can write (a command, an edit, a tool that acts outside Keel) in the same
// reply, is the model's next step in the same message: a command that makes a file and the read of that file.
// Run at once, the read found no file. It starts when the calls before it that can write have ended.
// The calls that can write do not wait for each other: independent commands overlap as they always did.
import type { ToolUseBlock } from "../core/types.ts";
import type { Tool } from "../tools/types.ts";

// Whether a tool's call may change what a later read finds: not a read, and not a tool that acts only on what Keel
// keeps (a wait, an agent, a question), which a read does not see.
export const writes = (t: Pick<Tool, "readOnly" | "kind"> | undefined): boolean =>
  !!t && !t.readOnly && (t.kind === undefined || t.kind === "shell" || t.kind === "edit");

export class StepOrder {
  private before: Promise<unknown>[] = [];
  constructor(private tools: readonly Pick<Tool, "name" | "readOnly" | "kind">[], private signal: AbortSignal) {}

  // `start` begins the call: at once, or for a read after the writes before it, when they have ended or the
  // turn was stopped (the call then answers the stop itself).
  run<T>(u: Pick<ToolUseBlock, "name">, start: () => Promise<T>): Promise<T> {
    const tool = this.tools.find((t) => t.name === u.name);
    if (tool?.readOnly && this.before.length && !this.signal.aborted) {
      const ahead = this.before.slice();
      let release = () => {};
      const stopped = new Promise<void>((r) => { release = r; this.signal.addEventListener("abort", release, { once: true }); });
      return Promise.race([Promise.allSettled(ahead), stopped]).finally(() => this.signal.removeEventListener("abort", release)).then(start);
    }
    const run = start();
    if (writes(tool)) this.before.push(run.then(() => {}, () => {}));
    return run;
  }
}
