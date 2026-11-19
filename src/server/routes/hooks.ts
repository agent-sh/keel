// The owner's hooks joined to the turn loop, and the routes that list hook
// files and pin a repository's file.
import type { RouteModule } from "../app.ts";
import { lineage } from "../../core/tree.ts";
import { registerHooks } from "../../engine/hooks.ts";
import { toMessages } from "../../engine/turn.ts";
import { Hooks, hookContext, namesOf, ownerHooksPath, projectRoot } from "../../integrations/hooks.ts";
import { gate, presence } from "./permissions.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status });
const bad = (error: string, status = 400) => json({ error }, status);

// A Stop hook sends the session back to work at most this many times in a row.
const STOP_LIMIT = 5;
export const HOOK_PREFIX = "[hook]";

export const hookRoutes: RouteModule = (deps) => {
  const { store, bus, engine, errors } = deps;
  const hooks = new Hooks(store);
  const answered = new Set<string>(); // user events already given to UserPromptSubmit
  const after = new Map<string, string[]>(); // call id -> PreToolUse context, joined to its result
  const stops = new Map<string, number>();
  const events = (id: string) => lineage(store.events(id), store.session(id)?.head ?? null);
  const note = (sid: string, event: string, lines: string[]) => {
    const ev = store.append(sid, "note", { text: hookContext(event, lines), model: true, hook: event });
    bus.emit({ t: "event", event: ev });
  };

  registerHooks({
    async beforeRequest(s, req) {
      const evs = events(s.id);
      let i = evs.length - 1;
      while (i >= 0 && (evs[i]!.kind === "turn_start" || evs[i]!.kind === "note")) i--;
      const last = evs[i];
      if (last?.kind !== "user" || answered.has(last.id)) return req;
      answered.add(last.id);
      const text = String(last.data.text ?? "");
      if (!text.startsWith(HOOK_PREFIX)) stops.delete(s.id); // the owner's own words start the count again
      const first = !evs.slice(0, i).some((e) => e.kind === "user");
      const [start, prompt] = await Promise.all([
        first ? hooks.run("SessionStart", s, { source: "startup" }) : null,
        hooks.run("UserPromptSubmit", s, { prompt: text }),
      ]);
      if (prompt.block) throw Object.assign(new Error(`A hook refused this prompt: ${prompt.block}`), { expected: true });
      const lines = [...(start?.context ?? []), ...prompt.context];
      if (!lines.length) return req;
      note(s.id, first ? "SessionStart, UserPromptSubmit" : "UserPromptSubmit", lines);
      return { ...req, messages: toMessages(events(s.id)) };
    },
    async beforeTool(s, call) {
      const target = call.tool.target ? await call.tool.target(call.input) : null;
      const name = target?.name ?? call.tool.name;
      const input = target ? target.input : call.input;
      const r = await hooks.run("PreToolUse", s, { tool_name: name, tool_input: input, tool_use_id: call.id }, namesOf(name, input, call.tool.name));
      if (r.block) return { deny: `A hook blocked this call: ${r.block}` };
      if (r.ask) {
        if (!gate) return { deny: `A hook asks the owner about this call (${r.ask}), and no one can be asked here.` };
        const d = await gate.askOnce(s, call, name, `a hook asks: ${r.ask}`);
        if (d) return d;
      }
      if (r.context.length) after.set(call.id, r.context);
    },
    async afterTool(s, call, result) {
      const target = call.tool.target ? await call.tool.target(call.input) : null;
      const name = target?.name ?? call.tool.name;
      const input = target ? target.input : call.input;
      const r = await hooks.run("PostToolUse", s, { tool_name: name, tool_input: input, tool_use_id: call.id, tool_response: result.content }, namesOf(name, input, call.tool.name));
      const lines = [...(after.get(call.id) ?? []), ...r.context, ...(r.block ? [`A hook says: ${r.block}`] : [])];
      after.delete(call.id);
      if (!lines.length) return;
      const block = hookContext(r.context.length || r.block ? "PostToolUse" : "PreToolUse", lines);
      if (typeof result.content === "string") result.content = `${result.content}\n\n${block}`;
      else result.content = [...result.content, { type: "text", text: block }];
    },
    async turnEnd(s, reason) {
      if (reason !== "end_turn") return;
      const last = [...events(s.id)].reverse().find((e) => e.kind === "assistant");
      const text = (last?.data.blocks ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
      const n = stops.get(s.id) ?? 0;
      const r = await hooks.run("Stop", s, { stop_hook_active: n > 0, last_assistant_message: text });
      if (!r.continueWith) { stops.delete(s.id); return; }
      if (n >= STOP_LIMIT) {
        note(s.id, "Stop", [`A Stop hook asked to go on ${n} times in a row; Keel stops here.`]);
        stops.delete(s.id);
        return;
      }
      stops.set(s.id, n + 1);
      // Queued: the next turn starts when this one has ended.
      try { engine.send(s.id, `${HOOK_PREFIX} ${r.continueWith}`, { mode: "queue", meta: { origin: "hook" } }); } catch (e) { errors.capture("server", e, { at: "stop hook" }); }
    },
    async beforeCompact(s) {
      await hooks.run("PreCompact", s, { trigger: "auto" });
    },
  });

  const workspaces = () => [...new Set(store.sessions({}).map((s) => projectRoot(s.workspace)).concat(projectRoot(deps.workspace)))];
  const shown = (cwd: string) => hooks.sources(cwd).map(({ groups, ...rest }) => rest);

  return {
    "/api/hooks": {
      GET: (req: Request) => {
        const cwd = new URL(req.url).searchParams.get("cwd");
        if (cwd) return json({ sources: shown(cwd), owner_path: ownerHooksPath() });
        // Every folder Keel has sessions in: the owner's file once, each repository's file.
        const seen = new Set<string>();
        const sources = workspaces().flatMap((w) => shown(w)).filter((s) => (seen.has(s.path) ? false : (seen.add(s.path), true)));
        return json({ sources, owner_path: ownerHooksPath() });
      },
    },
    "/api/hooks/trust": {
      POST: async (req: Request) => {
        // From a remote device, pinning a hook file (it will run commands) needs the owner's passkey.
        if (presence && !presence.allows(req, "hooks-trust")) return json({ error: "this needs your passkey from a remote device", presence: { action: "hooks-trust" } }, 428);
        const b = ((await req.json().catch(() => ({}))) ?? {}) as any;
        if (typeof b.sha256 !== "string") return bad("give the sha256 of the file you read");
        const cwd = typeof b.cwd === "string" ? b.cwd : deps.workspace;
        const err = hooks.pin(cwd, b.sha256);
        return err ? bad(err, 409) : json({ sources: shown(cwd) });
      },
    },
  };
};
