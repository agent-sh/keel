// Secrets kept out of history and provider requests (src/safety/secrets.ts):
// what is stored and sent to the UI is redacted, a tool call that names a
// placeholder runs with the value, and the model can ask the owner for a
// secret by name (request_secret), which its commands then get as a variable.
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, openSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { setConcealer } from "../../core/conceal.ts";
import { registerHooks } from "../../engine/hooks.ts";
import { nameError, SHELL_FIELDS, vault } from "../../safety/secrets.ts";
import { dropCallEnv, registerEnv, setCallEnv } from "../../tools/jobs.ts";
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

// The fields of a shell tool's input that hold the script (Bash, exec_command, run_shell_command).

let emitRequest: (r: SecretRequest, state: "open" | "closed") => void = () => {};

// The key placeholder ids are made with: 32 random bytes in the state folder,
// readable by the owner alone, made once. It is not a secret's value; with
// it and the store, a guessed value could be checked against an 8-hex id.
function placeholderKey(stateDir: string): Uint8Array {
  const path = join(stateDir, "secret-key");
  try {
    const fd = openSync(path, "wx", 0o600);
    const key = randomBytes(32);
    writeSync(fd, key);
    closeSync(fd);
    return key;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    chmodSync(path, 0o600);
    const key = readFileSync(path);
    if (key.length !== 32) throw new Error(`${path} is not a 32-byte key: remove it to make a new one (placeholders stored so far stop resolving)`);
    return key;
  }
}

export const secretRoutes: RouteModule = (deps: Deps) => {
  const { store, bus } = deps;
  vault.parentOf = (id) => store.session(id)?.parent_id;
  // Placeholders mean the same after a restart: the same key, and the ids issued kept (never a value).
  vault.useKey(placeholderKey(store.stateDir));
  store.migrate(`CREATE TABLE IF NOT EXISTS secret_placeholders (id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT, created INTEGER NOT NULL)`);
  const issue = store.db.query("INSERT INTO secret_placeholders (id, kind, name, created) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = COALESCE(excluded.name, name)");
  const issued = store.db.query("SELECT 1 FROM secret_placeholders WHERE id = ?");
  vault.ledger = { issued: (id, kind, name) => void issue.run(id, kind, name ?? null, Date.now()), has: (id) => !!issued.get(id) };

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
      "Secrets: text like [secret:1a2b3c4d] or [value of $NAME] stands for a secret kept out of the conversation. Write it as it is where the value is needed: a tool input that contains it runs with the real value, and output shows the placeholder again. In a shell command it stands for a quoted variable holding the value, so write it as one word, never inside other syntax. Named ones are also in your commands' environment as $NAME. To get a secret, use request_secret; never ask for one in the chat.",
    // The system prompt (instruction files) is sent redacted too, and no new
    // message of a request carries a known value: whatever path put one there,
    // it does not reach a model. History already sent to that model goes as it
    // went (vault.maskSent): stored events are redacted when written, so only a
    // value found later is in an earlier one, and that model has it already.
    beforeRequest: (s, req) => ({ ...req, system: vault.redact(req.system, s.id, "output"), messages: vault.maskSent(`${s.id} ${req.route ?? req.model}`, req.messages) }),
    // A value is put back only where a credential is used: a shell command on
    // this machine, as a quoted variable set on that command's process alone
    // (and named secrets in the environment of the session's jobs). Every
    // other tool keeps the placeholder: loops, tasks, notes and the like would
    // store it, an advisor, side question or subagent would send it to a
    // model, an MCP or web call would send it to a server. A call bound for
    // another machine is sent with placeholders (src/fleet/remote.ts).
    // A placeholder where no variable can expand (a quoted heredoc's body)
    // would reach the command as its own text: the call is refused, saying how
    // to write it. Splicing the value in would put it in the script's syntax,
    // and unquoting the heredoc would change what every other $ in it means.
    // A placeholder whose value this daemon does not hold now (a restart
    // forgot it) would run as its own text: refused, naming it. A file tool
    // never writes a value (only a command is given one) and writing the
    // placeholder would put its text in the file: refused too, saying how.
    beforeTool(s, call) {
      if (!call.input || typeof call.input !== "object" || call.ctx.dispatch) return;
      if (call.tool.kind === "edit") {
        const { held, gone } = vault.placeholders(call.input, s.id);
        if (!held.length && !gone.length) return;
        return { deny: `${[...held, ...gone].join(", ")} stands for a secret; a file tool writes neither its value nor its text, so nothing was written. Where the file holds the value you read as the placeholder, change the text around it and leave that line out of your edit. To put a value in a file, use a shell command, where the placeholder stands for it: printf '%s\n' "NAME=<the placeholder>" >> .env.` };
      }
      if (call.tool.kind !== "shell") return;
      const { gone } = vault.placeholders(call.input, s.id, SHELL_FIELDS);
      if (gone.length) return { deny: `${gone.join(", ")} stands for a secret this daemon does not hold now (values are kept in memory only: a restart, or removing it, forgets them); nothing ran. Read it again from where it came from (it gets the same placeholder), or ask the owner with request_secret.` };
      const { stuck } = vault.reveal(call.input, s.id, SHELL_FIELDS);
      if (!stuck.length) return;
      return { deny: `${[...new Set(stuck)].join(", ")} stands inside a quoted heredoc (<<'EOF'), where nothing expands, so the command would get the placeholder text, not the secret; nothing ran. Use an unquoted heredoc (<<EOF, where it expands) or put the placeholder outside it, for example: printf '%s' <the placeholder> | your-command.` };
    },
    execInput(s, call) {
      if (call.tool.kind !== "shell" || call.ctx.dispatch || call.tool.peer) return;
      const { value, used, env } = vault.reveal(call.input, s.id, SHELL_FIELDS);
      if (Object.keys(env).length) setCallEnv(call.id, env);
      if (used.length) return value;
    },
    afterTool: (_s, call) => dropCallEnv(call.id),
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
