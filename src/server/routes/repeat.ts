// The same call answering the same way again and again (engine/repeat.ts):
// a note on the third answer, a refusal on the sixth call. And a wait polled
// again in a shell (engine/wait-poll.ts): a line naming the wait tool.
import { registerHooks } from "../../engine/hooks.ts";
import { observe, refuse, reset } from "../../engine/repeat.ts";
import { observeWait, resetWait } from "../../engine/wait-poll.ts";
import type { RouteModule } from "../app.ts";

export const repeatRoutes: RouteModule = ({ providers }) => {
  // The wait tools this session's family has, by name (Claude Code's names unless GPT or Gemini).
  const waitTools = (model: string) => {
    const f = providers.current().find((m) => m.id === model)?.family;
    return f === "gpt" || f === "gemini" ? "wait_for (or monitor for a log)" : "WaitFor (or Monitor for a log)";
  };
  registerHooks({
    beforeTool(s, call) {
      const why = refuse(s.id, call.tool.name, call.input);
      return why ? { deny: why } : undefined;
    },
    afterTool(s, call, result) {
      const repeated = observe(s.id, call.tool.name, call.input, result, waitTools(s.model));
      // The wait tool by the name this session's tool set has it, if it has one.
      const polled = observeWait(s.id, call.tool.name, call.input, ["WaitFor", "wait_for"].find((n) => call.ctx.offers?.(n)));
      // (A repeat's note already names the wait tool.)
      const note = repeated ?? polled;
      if (!note) return;
      if (typeof result.content === "string") result.content = `${result.content}\n\n${note}`;
      else result.content = [...result.content, { type: "text", text: note }];
    },
    turnEnd: (s) => { reset(s.id); resetWait(s.id); },
  });
  return {};
};
