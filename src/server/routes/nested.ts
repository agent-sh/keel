// Nested instruction files (engine/nested.ts): appended to the result of the
// call that reached their folder. A failed result gets them too (an edit
// refused for a stale read still went there).
import { nestedFor, stepStored } from "../../engine/nested.ts";
import { registerHooks } from "../../engine/hooks.ts";
import type { RouteModule } from "../app.ts";

export const nestedRoutes: RouteModule = ({ store, errors }) => {
  registerHooks({
    afterTool(s, call, result) {
      try {
        const blocks = nestedFor(store, s, call.tool, call.input, call.tool.cwdOf?.(call.ctx, call.input));
        if (!blocks.length) return;
        const text = blocks.join("\n\n");
        if (typeof result.content === "string") result.content = result.content ? `${result.content}\n\n${text}` : text;
        else result.content = [...result.content, { type: "text", text }];
      } catch (e) {
        errors.capture("server", e, { at: "nested instructions", session: s.id, tool: call.tool.name });
      }
    },
    stepDone: (s) => stepStored(s.id),
    turnEnd: (s) => stepStored(s.id),
  });
  return {};
};
