// Secrets kept out of history and provider requests (src/safety/secrets.ts):
// what is stored and sent to the UI is redacted, a tool call that names a
// placeholder runs with the value, and the model can ask the owner for a
// secret by name (request_secret), which its commands then get as a variable.
import { setConcealer } from "../../core/conceal.ts";
import { registerHooks } from "../../engine/hooks.ts";
import { nameError, vault } from "../../safety/secrets.ts";
import { registerEnv } from "../../tools/jobs.ts";
import { registerShared } from "../../tools/registry.ts";
import type { Tool, ToolContext } from "../../tools/types.ts";
import type { Deps, RouteModule } from "../app.ts";
import { gate } from "./permissions.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status });
const bad = (error: string, status = 400) => json({ error }, status);

export type SecretRequest = { id: string; session_id: string; name: string; purpose?: string; created: number };
type Waiting = SecretRequest & { resolve: (r: { given: true } | { given: false; reason?: string }) => void };
const waiting = new Map<string, Waiting>();

const RequestSecret: Tool = {
  name: "request_secret",
  description:
    "Ask the owner for a secret (an API key, a token, a password) by the environment variable name your commands should read it from. " +
    "The owner types it into a card; you never see the value. After it is given, your commands have it as $NAME, and a tool input that contains [value of $NAME] gets the value. " +
    "Use this instead of asking the owner to paste a secret into the chat.",
  input_schema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Environment variable name, e.g. GITHUB_TOKEN" },
      purpose: { type: "string", description: "One sentence: what it is for" },
    },
    required: ["name"],
  },
  readOnly: true, // the card is the owner's decision; nothing changes until they answer
  async run(input: any, ctx: ToolContext) {
    const name = String(input?.name ?? "").trim();
    const err = nameError(name);
    if (err) return { content: `Not asked: ${err}.`, is_error: true };
    const already = vault.env(ctx.sessionId)[name];
    if (already) return { content: `The owner already gave ${name}: your commands have it as $${name}.` };
    const req: SecretRequest = { id: ctx.callId ?? crypto.randomUUID(), session_id: ctx.sessionId, name, purpose: String(input?.purpose ?? "").slice(0, 300) || undefined, created: Date.now() };
    const out = await new Promise<{ given: true } | { given: false; reason?: string }>((resolve) => {
      const done = (r: { given: true } | { given: false; reason?: string }) => {
        if (!waiting.delete(req.id)) return;
        ctx.signal.removeEventListener("abort", onAbort);
        emitRequest(req, "closed");
        resolve(r);
      };
      const onAbort = () => done({ given: false, reason: "the turn was stopped" });
      waiting.set(req.id, { ...req, resolve: done });
      emitRequest(req, "open");
      if (ctx.signal.aborted) onAbort();
      else ctx.signal.addEventListener("abort", onAbort, { once: true });
    });
    if (!out.given) return { content: `The owner did not give ${name}${out.reason ? `: ${out.reason}` : "."} Do not ask for it again in this turn.`, is_error: true };
    return { content: `The owner gave ${name}. Your commands have it as $${name}; write [value of $${name}] in a tool input that needs the value itself. You never see the value; output that contains it shows [value of $${name}].` };
  },
};

// Files written outside the Store (job sidecars and logs, spill files, trace
// rows) keep placeholders too. Set at load, before any route adopts old jobs.
setConcealer({ text: (s, sessionId) => vault.redact(s, sessionId, "output"), pairs: () => vault.pairs() });

let emitRequest: (r: SecretRequest, state: "open" | "closed") => void = () => {};

export const secretRoutes: RouteModule = (deps: Deps) => {
  const { store, bus } = deps;
  vault.parentOf = (id) => store.session(id)?.parent_id;

  // Everything stored is redacted; images, signatures and reasoning stay byte-exact.
  store.redact = (sessionId, kind, value) => {
    if (typeof value === "string") return vault.redact(value, sessionId, kind === "title" || kind === "queue" ? "prompt" : "output");
    return vault.redactDeep(value, sessionId, kind === "user" ? "prompt" : "output");
  };
  // Live frames: the streamed text and feature frames (approval cards).
  // Stored events were redacted on the way in.
  bus.use((f) => {
    if (f.t === "delta") return { ...f, text: vault.redact(f.text, f.session_id, "output") };
    if (f.t === "feature" && f.name !== "secret") return { ...f, data: vault.redactDeep(f.data, f.session_id ?? null, "output") };
    return f;
  });
  if (gate) gate.redact = (a) => vault.redactDeep(a, a.session_id, "output");
  emitRequest = (r, state) => bus.emit({ t: "feature", name: "secret", session_id: r.session_id, data: { request: r, state } });
  vault.on((ev) => {
    if (ev.type === "found") bus.emit({ t: "feature", name: "secret", session_id: ev.session_id, data: { found: ev.secret } });
    else if (ev.type === "changed") for (const s of ev.secret.sessions) bus.emit({ t: "feature", name: "secret", session_id: s, data: { changed: ev.secret } });
    else bus.emit({ t: "feature", name: "secret", data: { forgotten: ev.id } });
  });
  registerEnv((sessionId) => vault.env(sessionId));
  registerShared(RequestSecret);

  registerHooks({
    system: () =>
      "Secrets: text like [secret:1a2b3c4d] or [value of $NAME] stands for a secret kept out of the conversation. Write it as it is where the value is needed: a tool input that contains it runs with the real value, and output shows the placeholder again. Named ones are also in your commands' environment as $NAME. To get a secret, use request_secret; never ask for one in the chat.",
    // The system prompt (instruction files) is sent redacted too.
    beforeRequest: (s, req) => ({ ...req, system: vault.redact(req.system, s.id, "output") }),
    // A call that names a placeholder runs with the value. Only the tool sees
    // it: cards, other hooks, traces and records keep the placeholder.
    execInput(s, call) {
      const { value, used } = vault.reveal(call.input, s.id);
      if (used.length) return value;
    },
  });

  const body = async (req: Request) => ((await req.json().catch(() => ({}))) ?? {}) as any;

  return {
    "/api/sessions/:id/secrets": {
      GET: (req: any) => {
        if (!store.session(req.params.id)) return bad("no such session", 404);
        const requests = [...waiting.values()].filter((w) => w.session_id === req.params.id).map(({ resolve: _r, ...r }) => r);
        return json({ secrets: vault.list(req.params.id), requests });
      },
    },
    // The owner gives (or declines) a secret a tool asked for.
    "/api/sessions/:id/secrets/:rid": {
      POST: async (req: any) => {
        const w = waiting.get(req.params.rid);
        if (!w || w.session_id !== req.params.id) return bad("no secret request is open with that id", 404);
        const b = await body(req);
        if (b.deny) {
          w.resolve({ given: false, reason: typeof b.reason === "string" && b.reason.trim() ? b.reason.trim().slice(0, 300) : undefined });
          return json({ ok: true });
        }
        const value = typeof b.value === "string" ? b.value.replace(/\r?\n$/, "") : "";
        if (!value) return bad("give the value, or deny");
        if (value.length > 16_384) return bad("the value is over 16 KB");
        vault.add(value, "given secret", "card", w.session_id, w.name);
        w.resolve({ given: true });
        return json({ ok: true, name: w.name });
      },
    },
    "/api/secrets": {
      GET: () => json({ secrets: vault.list() }),
    },
    "/api/secrets/:sid": {
      // Name a secret: commands of its sessions get it as that variable.
      PATCH: async (req: any) => {
        const b = await body(req);
        try {
          return json({ secret: vault.rename(req.params.sid, typeof b.name === "string" && b.name.trim() ? b.name.trim() : null) });
        } catch (e) {
          const st = (e as any).status;
          if (st) return bad((e as Error).message, st);
          throw e;
        }
      },
      DELETE: (req: any) => (vault.forget(req.params.sid) ? json({ ok: true }) : bad("no such secret", 404)),
    },
  };
};
