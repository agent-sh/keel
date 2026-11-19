// Sessions elsewhere: the owner's Claude Code, Codex and agy sessions, listed
// and driven through the agent view. A route call is the owner's own act; the
// same acts from a model go through the deferred keel__session_* tools and the
// permission gate.
import { existsSync, statSync } from "node:fs";
import * as av from "../../drive/agentview.ts";
import { DriveError, sharedDrive } from "../../drive/drive.ts";
import { saysNo } from "../../drive/text.ts";
import { driveTools } from "../../drive/tools.ts";
import { registerHooks } from "../../engine/hooks.ts";
import { registerCatalog } from "../../tools/catalog.ts";
import type { Deps, RouteModule } from "../app.ts";
import { presence } from "./permissions.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status });
const bad = (error: string, status = 400, code?: string) => json({ error, code }, status);
const fail = (e: unknown) => (e instanceof DriveError ? bad(e.message, e.status, e.code) : bad((e as Error).message, 500));

// What the page shows of one read: generous, since the owner scrolls it.
const PAGE_BUDGET = 200_000;

export const driveRoutes: RouteModule = (deps: Deps) => {
  const drive = sharedDrive();
  drive.onList.push((sessions) => deps.bus.emit({ t: "feature", name: "outside", data: { sessions, at: Date.now() } }));
  registerCatalog({ name: "keel", tools: async () => driveTools(drive, deps.store, deps.providers) });
  registerHooks({
    system: () =>
      drive.configured()
        ? "The owner's sessions of other harnesses (Claude Code, Codex, agy) can be listed, read and messaged: search_tools \"sessions\" finds keel__sessions_all, keel__session_read, keel__session_send, keel__session_answer, keel__session_model and keel__session_resume. Read a session before acting on it; never answer its prompts or message it unless the task asks for that."
        : "",
  });

  const id = (req: any) => decodeURIComponent(req.params.id);
  const body = async (req: Request) => ((await req.json().catch(() => ({}))) ?? {}) as any;

  return {
    "/api/fleet/outside": {
      // The list the agent view printed last when it is fresh; a stale one comes
      // at once and the new one follows as an `outside` frame.
      GET: async (req: any) => {
        const configured = drive.configured();
        if (!configured) return json({ configured, sessions: [], not_listed: ["no agent view is set: name its program in Settings, Sessions elsewhere"] });
        const fresh = new URL(req.url).searchParams.has("refresh");
        const c = drive.cached();
        if (c && !fresh) {
          drive.raws().catch((e) => deps.errors.capture("server", e, { at: "drive list" }));
          return json({ configured, sessions: c.rows, at: c.at });
        }
        const r = await drive.list(fresh ? 0 : undefined);
        if (r.not_listed) deps.errors.capture("server", new Error(r.not_listed[0]), { at: "drive list" });
        return json({ configured, ...r, at: Date.now() });
      },
    },
    "/api/fleet/outside/settings": {
      GET: () => json({ agent_view: av.settings().agent_view ?? "" }),
      PUT: async (req: any) => {
        const b = await body(req);
        const p = typeof b.agent_view === "string" ? b.agent_view.trim() : "";
        if (p && (!existsSync(p) || !statSync(p).isFile())) return bad(`not a file: ${p}`);
        av.setAgentView(p || null);
        return json({ agent_view: p });
      },
    },
    "/api/fleet/outside/:id": {
      GET: async (req: any) => {
        const n = new URL(req.url).searchParams.get("lines");
        const lines = n === null ? 80 : Number(n);
        if (!Number.isInteger(lines) || lines <= 0) return bad("lines is a whole number above 0");
        try {
          const r = await drive.read(id(req), { lines, budget: PAGE_BUDGET });
          return json({ session: r.session, turns: r.turns, lines: r.lines, prompt: r.prompt });
        } catch (e) {
          return fail(e);
        }
      },
      POST: async (req: any) => {
        // A send, an answer or a model switch from a remote device is the owner's: his passkey.
        if (presence && !presence.allows(req, "outside")) return json({ error: "this needs your passkey from a remote device", presence: { action: "outside" } }, 428);
        const b = await body(req);
        try {
          if (b.action === "send") {
            if (typeof b.text !== "string" || !b.text.trim()) return bad("text cannot be empty");
            return json({ ok: true, message: await drive.send(id(req), b.text) });
          }
          if (b.action === "model") {
            if (typeof b.model !== "string") return bad("give model");
            return json({ ok: true, message: await drive.model(id(req), b.model) });
          }
          if (b.action === "answer") {
            if (typeof b.request !== "string" || typeof b.hash !== "string" || typeof b.choice !== "string") return bad("give request, hash and choice");
            // The owner picks an option; the option says which answer it is.
            const f = await drive.find(id(req));
            const p = await drive.prompt(f);
            const label = p?.choices?.find((c) => c.value === b.choice)?.label ?? "";
            const decision = b.decision ?? (saysNo(label) ? "deny" : "allow");
            return json({ ok: true, message: await drive.answer(f.row.id, { request: b.request, hash: b.hash, decision, choice: b.choice, note: b.note }, f) });
          }
          return bad("action is send, answer or model");
        } catch (e) {
          if (!(e instanceof DriveError)) deps.errors.capture("server", e, { at: "drive act", action: b.action });
          return fail(e);
        }
      },
    },
  };
};
