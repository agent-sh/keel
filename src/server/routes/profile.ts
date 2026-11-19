// A session's profile: the model it runs on, its reasoning and speed choices
// with what the model offers, the tool profile its family gets, and the
// instruction files the session's prompt carries. POST picks a model with its
// reasoning and speed in one step (applied from the next request, also mid-turn).
import { commitSwitch } from "../switch.ts";
import { readFileSync, statSync } from "node:fs";
import { instructionPaths } from "../../engine/turn.ts";
import { loadedPaths } from "../../engine/nested.ts";
import type { RouteModule } from "../app.ts";
import { speedOffer } from "../../providers/registry.ts";
import type { ModelInfo } from "../../providers/types.ts";
import { toolsFor } from "../../tools/registry.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status });
const INSTRUCTION_LIMIT = 40_000; // what the system prompt includes of one file (engine/turn.ts)

// The instruction files the prompt reads (engine/turn.ts), with their sizes,
// then the nested ones the work has loaded since (engine/nested.ts).
function instructions(cwd: string, nested: Iterable<string> = []) {
  const files: { path: string; scope: string; bytes: number; included_bytes: number; truncated: boolean }[] = [];
  const warnings: string[] = [];
  for (const { path, scope } of [...instructionPaths(cwd), ...[...nested].map((path) => ({ path, scope: "nested" }))]) {
    try {
      const bytes = statSync(path).size;
      const included = Buffer.byteLength(readFileSync(path, "utf8").slice(0, INSTRUCTION_LIMIT));
      files.push({ path, scope, bytes, included_bytes: included, truncated: included < bytes });
      if (included < bytes) warnings.push(`${path} is cut at ${INSTRUCTION_LIMIT} characters`);
    } catch (e) {
      warnings.push(`${path}: ${(e as Error).message}`);
    }
  }
  return { files, warnings };
}

// How a family's tools edit files, read off its tool set.
function toolProfile(info: ModelInfo) {
  const tools = toolsFor(info.family);
  const names = tools.map((t) => t.name);
  const patch = tools.find((t) => t.freeform);
  const edit_grammar = patch ? `${patch.name} (${patch.freeform!.syntax} grammar)` : names.includes("Edit") ? "Edit (exact string replace)" : names.includes("replace") ? "replace (exact string replace)" : "none";
  const label = { claude: "Claude Code tools", gpt: "Codex tools", gemini: "Gemini CLI tools", other: "Claude Code tools" }[info.family];
  return { tool_profile: { label, family: info.family, edit_grammar }, eager_tools: names };
}

export const profileRoutes: RouteModule = ({ store, bus, providers }) => {
  const answer = async (id: string) => {
    const s = store.session(id);
    if (!s) return null;
    const info = (await providers.models()).find((m) => m.id === s.model);
    const offer = info ? speedOffer(info, s.settings.speed) : undefined;
    return {
      session: s,
      model: info ? { id: info.id, name: info.name, provider: info.provider, family: info.family, context: info.context, output: info.output, billing: info.billing, price: info.price } : null,
      reasoning: { choice: s.settings.effort && info?.efforts.includes(s.settings.effort) ? s.settings.effort : undefined, options: info?.efforts.length ? { kind: "levels", levels: info.efforts } : { kind: info ? "none" : "unknown" } },
      speed: { choice: offer?.id ?? "standard", options: [{ speed: "standard", label: "Standard", available: true }, ...(info?.speeds ?? []).map((o) => ({ speed: o.id, label: o.label, available: true, note: o.note, price: o.price }))] },
      ...(info ? toolProfile(info) : { tool_profile: null, eager_tools: [] }),
      instructions: instructions(s.workspace, s.machine ? [] : loadedPaths(store, s.id)),
    };
  };

  return {
    "/api/sessions/:id/profile": {
      GET: async (req: Request & { params: { id: string } }) => {
        const a = await answer(req.params.id);
        return a ? json(a) : json({ error: "no such session" }, 404);
      },
      // { model, reasoning?, speed? }: absent reasoning drops the old model's
      // choice; absent speed stays where the new model offers it.
      POST: async (req: Request & { params: { id: string } }) => {
        const s = store.session(req.params.id);
        if (!s) return json({ error: "no such session" }, 404);
        const b = (await req.json().catch(() => null)) as { model?: string; provider?: string; reasoning?: string; speed?: string } | null;
        const id = b?.model ? (b.model.includes(":") ? b.model : `${b.provider ?? ""}:${b.model}`) : "";
        if (!id || id.startsWith(":")) return json({ error: "a profile names its model" }, 400);
        let info: ModelInfo;
        try { info = (await providers.resolve(id)).info; } catch (e) { return json({ error: (e as Error).message }, 400); }
        if (b!.reasoning && !info.efforts.includes(b!.reasoning)) return json({ error: `${info.name} takes ${info.efforts.length ? info.efforts.join(", ") : "no reasoning setting"}` }, 400);
        const settings = { ...s.settings };
        if (b!.reasoning) settings.effort = b!.reasoning; else delete settings.effort;
        if (b!.speed && b!.speed !== "standard") {
          const o = speedOffer(info, b!.speed);
          if (!o) return json({ error: `${info.name} has no ${b!.speed} speed on ${info.provider}` }, 400);
          settings.speed = o.id;
        } else if (b!.speed === "standard" || !speedOffer(info, settings.speed)) delete settings.speed;
        bus.emit({ t: "session", session: await commitSwitch(store, bus, providers, s, info, { settings }) });
        return json(await answer(s.id));
      },
    },

    // { speed: "standard" | an offer of the session's model }
    "/api/sessions/:id/speed": {
      POST: async (req: Request & { params: { id: string } }) => {
        const s = store.session(req.params.id);
        if (!s) return json({ error: "no such session" }, 404);
        const b = (await req.json().catch(() => null)) as { speed?: string } | null;
        const info = (await providers.models()).find((m) => m.id === s.model);
        const settings = { ...s.settings };
        if (!b?.speed || b.speed === "standard") delete settings.speed;
        else {
          const o = info && speedOffer(info, b.speed);
          if (!o) return json({ error: `${info?.name ?? s.model} has no ${b.speed} speed on ${info?.provider ?? "its route"}` }, 400);
          settings.speed = o.id;
        }
        bus.emit({ t: "session", session: store.updateSession(s.id, { settings }) });
        return json(await answer(s.id));
      },
    },
  };
};
