// Voice through parlar: GET/POST /api/sessions/:id/voice (talk, mute, unmute, stop)
// and the bundled say tool.
import type { RouteModule } from "../app.ts";
import type { McpManager } from "../../mcp/manager.ts";
import { discoverParlar, installVoice, Voice } from "../../integrations/voice.ts";
import { ownerHome, ownerLookup } from "../../core/paths";

const json = (data: unknown, status = 200) => Response.json(data, { status });
const bad = (error: string, status = 400) => json({ error }, status);
const ACTIONS = ["talk", "mute", "unmute", "stop"];

export const voiceRoutes: RouteModule = (deps) => {
  const g = globalThis as { __keelMcp?: McpManager; __keelVoice?: Voice };
  // Under `bun --hot` this module runs again: the old waits and watch end first.
  g.__keelVoice?.shutdown();
  const found = discoverParlar(ownerHome(), ownerLookup);
  const v = "bin" in found ? new Voice(found.bin, deps.store, deps.engine, deps.bus, deps.errors) : null;
  g.__keelVoice = v ?? undefined;
  installVoice(v, g.__keelMcp, deps.bus, found);

  return {
    "/api/sessions/:id/voice": {
      GET: async (req: any) => {
        if (!deps.store.session(req.params.id)) return bad("no such session", 404);
        return json(v ? await v.state(req.params.id) : { available: false });
      },
      POST: async (req: any) => {
        const s = deps.store.session(req.params.id);
        if (!s) return bad("no such session", 404);
        const b = ((await req.json().catch(() => ({}))) ?? {}) as any;
        if (!ACTIONS.includes(b.action)) return bad(`unknown action ${b.action}: use talk, mute, unmute or stop`);
        if (!v) return bad("parlar is not installed on this machine", 409);
        try {
          return json(await v.control(s.id, b.action));
        } catch (e) {
          const state = (e as any).state;
          return json(state ? { error: (e as Error).message, state } : { error: (e as Error).message }, (e as any).status ?? 502);
        }
      },
    },
  };
};
