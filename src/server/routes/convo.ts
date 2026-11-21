// Conversation operations beside the turn loop: a recap written on demand,
// summarizing a part of the conversation (from a prompt on, or everything
// before it), a skill kept on as the session's mode, and the model's own
// context tools (how full its context is, and a fresh context it starts with
// a handoff note). Every model call here runs on the session's own request
// prefix (Engine.ask), so it reads the cache the turns wrote; nothing earlier
// is rewritten: a summary is a new event, the old branch stays.
import type { Message, Session, StoredEvent } from "../../core/types.ts";
import { checkpointAt, COMPACT_SHARE, contextTokens, headMoved, checkpointData, settle, STATEMENTS_FORMAT } from "../../engine/compact.ts";
import { warmUntil } from "../../admin/telemetry.ts";
import { registerHooks } from "../../engine/hooks.ts";
import { registerShared } from "../../tools/registry.ts";
import { discoverSkills, renderForOwner } from "../../tools/skills.ts";
import { fail, ok, type Tool } from "../../tools/types.ts";
import type { RouteModule } from "../app.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status });
const bad = (error: string, status = 400) => json({ error }, status);

// Claude Code caps a recap at 400 characters; Codex's next action at 200.
export const RECAP_CHARS = 400;
export const NEXT_CHARS = 200;

export type Digest = { recap?: string; recap_seq: number; next_prompt?: string; ts_ms: number; cost_usd?: number; model?: string };

const RECAP_PROMPT = [
  "[harness] The owner is coming back to this session. Do not call tools and do not continue the work.",
  `Reply with one JSON object only: {"recap": "...", "next": "..."}.`,
  `recap: one or two sentences (at most ${RECAP_CHARS} characters): where the work stands, what was done last, and what it waits for, if anything.`,
  `next: the message the owner is most likely to send next (at most ${NEXT_CHARS} characters), or "" when there is none.`,
].join("\n");

// The model's reply as {recap, next}: one JSON object, also inside a code fence;
// a reply that is not JSON is the recap itself. Fields that are not strings or
// are empty are left out.
export function parseDigest(text: string): { recap?: string; next?: string } {
  const t = text.trim();
  const body = t.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1] ?? t.slice(Math.max(0, t.indexOf("{")), t.lastIndexOf("}") + 1);
  const cut = (v: unknown, n: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : undefined);
  try {
    const o = JSON.parse(body);
    if (o && typeof o === "object") return { recap: cut(o.recap ?? o.summary, RECAP_CHARS), next: cut(o.next ?? o.next_prompt ?? o.next_action, NEXT_CHARS) };
  } catch {}
  return { recap: cut(t, RECAP_CHARS) };
}

const PART_FROM = (excerpt: string, focus?: string) => [
  `[harness] The owner is summarizing a part of this conversation: from their message that begins "${excerpt}" to the end. That part will be replaced by your summary; everything before it stays as it is.`,
  "Write the summary of that part only, so the work can go on without it.",
  STATEMENTS_FORMAT,
  "In your own words: what was asked, files read or changed and why, commands and results that still matter, and where it stands. Be specific: names, paths, numbers, error text. Do not call tools; reply with the summary only.",
  focus ? `\nKeep above all: ${focus}` : "",
].join("\n");

const PART_UP_TO = (excerpt: string, focus?: string) => [
  `[harness] The owner is summarizing a part of this conversation: everything before their message that begins "${excerpt}". That part will be replaced by your summary; that message and everything after it stay as they are.`,
  "Write the summary of that earlier part only, so the work can go on without it.",
  STATEMENTS_FORMAT,
  "In your own words: what was asked, files read or changed and why, commands and results that still matter, and where it stood. Be specific: names, paths, numbers, error text. Do not call tools; reply with the summary only.",
  focus ? `\nKeep above all: ${focus}` : "",
].join("\n");

const excerpt = (t: string) => t.replace(/\s+/g, " ").trim().slice(0, 120);
const textOf = (blocks: any[]) => blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
const ask = (text: string): Message[] => [{ role: "user", content: [{ type: "text", text }] }];

// The events the model sees now: from the last checkpoint's first kept event.
const visible = (line: readonly StoredEvent[]) => line.slice(checkpointAt(line).keepFrom);

// The skill-mode note in force on this branch, if any.
const modeNote = (line: readonly StoredEvent[]) => visible(line).findLast((e) => e.kind === "note" && e.data.kind === "skill_mode");

export const convoRoutes: RouteModule = ({ store, bus, engine, providers, errors }) => {
  store.migrate(`CREATE TABLE IF NOT EXISTS session_digests (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  data TEXT NOT NULL
);`);
  const digestOf = (id: string): Digest | null => {
    const r = store.db.query<{ data: string }, [string]>("SELECT data FROM session_digests WHERE session_id = ?").get(id);
    return r ? JSON.parse(r.data) : null;
  };
  const append = (id: string, kind: StoredEvent["kind"], data: unknown, parent?: string | null) => {
    const e = store.append(id, kind, data, parent);
    bus.emit({ t: "event", event: e });
    return e;
  };
  const emitSession = (id: string) => {
    const s = store.session(id);
    if (s) bus.emit({ t: "session", session: s });
    return s;
  };

  // --- skill mode: kept on through a note the model reads, written at the
  // next request of a turn (and again after a compaction dropped it), so the
  // system prompt and the history before it stay byte for byte.
  const modeText = (s: Session, name: string | null): string => {
    if (!name) return "[harness] The owner turned the skill mode off: the standing instructions of the skill named before no longer apply.";
    const r = renderForOwner(name, "", s.workspace, s.id);
    if ("error" in r) return `[harness] The skill mode ${name} could not be loaded (${r.error}).`;
    return `[harness] The owner set the skill "${name}" as this session's mode: follow its instructions on every turn until they turn it off.\n\n${r.text}`;
  };
  registerHooks({
    beforeRequest(s, req) {
      if (req.purpose !== "turn") return req;
      const want = s.settings.skill_mode ?? null;
      const line = engine.lineage(s.id);
      const now = modeNote(line)?.data.skill_mode ?? null;
      if (want === now) return req;
      const text = modeText(s, want);
      append(s.id, "note", { kind: "skill_mode", model: true, skill_mode: want, text });
      const messages = [...req.messages];
      const last = messages.at(-1);
      if (last?.role === "user") messages[messages.length - 1] = { role: "user", content: [...last.content, { type: "text", text }] };
      else messages.push({ role: "user", content: [{ type: "text", text }] });
      return { ...req, messages };
    },
  });

  // --- the model's own context tools
  const handoffs = new Map<string, string>();
  const modelOf = async (s: Session) => (await providers.models()).find((m) => m.id === s.model);
  const ContextStatus: Tool = {
    name: "keel__context_status",
    readOnly: true,
    description: "How full your context is now: tokens used, the model's window, tokens left, where it compacts, and how long the provider's prompt cache stays warm. Use it before a long read or when deciding whether to start a fresh context.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
    async run(_input, ctx) {
      const s = store.session(ctx.sessionId);
      if (!s) return fail("NOT_AVAILABLE: this session is gone.");
      const line = engine.lineage(s.id);
      const used = contextTokens(line, s.model).used;
      const info = await modelOf(s);
      const window = info?.context;
      const compacts = s.settings.compact_at ?? (window ? Math.floor(window * COMPACT_SHARE) : undefined);
      // By the lifetime the last request asked for; null where the provider states none.
      const until = warmUntil(store, s.id);
      const warm = until === undefined ? null : Math.max(0, Math.round((until - Date.now()) / 1000));
      return ok(JSON.stringify({ context_used_tokens: used, context_window: window, tokens_left: window ? Math.max(0, window - used) : undefined, compacts_at_tokens: compacts, cache_warm_seconds: warm }));
    },
  };
  const NewContext: Tool = {
    name: "keel__new_context",
    readOnly: true,
    description: "Start a fresh context yourself: after this step, everything so far is replaced by your handoff note (no other summary is written), with the owner's own messages kept verbatim, and the turn goes on. Use it when the context is full of material you no longer need. The handoff must hold all you need to go on: the goal, decisions, files and their state, what is done, and the exact next step.",
    input_schema: { type: "object", properties: { handoff: { type: "string", description: "Everything you need to continue the work without the conversation so far." } }, required: ["handoff"], additionalProperties: false },
    async run(input, ctx) {
      const h = String(input?.handoff ?? "").trim();
      if (!h) return fail("Give the handoff note: the goal, decisions, files, what is done and the exact next step.");
      handoffs.set(ctx.sessionId, h);
      return ok("A fresh context starts after this step, with your handoff note as its summary.");
    },
  };
  registerShared(ContextStatus, NewContext);
  registerHooks({
    stepDone(s) {
      const h = handoffs.get(s.id);
      if (!h) return;
      handoffs.delete(s.id);
      const line = engine.lineage(s.id);
      append(s.id, "compaction", {
        mode: "summary", ...checkpointData(line, h), auto: true, trigger: "model",
        tokens_before: contextTokens(line, s.model).used, label: "The model started a fresh context with a handoff note",
      });
      emitSession(s.id);
    },
    turnEnd(s) { handoffs.delete(s.id); },
  });

  return {
    "/api/sessions/:id/recap": {
      GET: (req: any) => (store.session(req.params.id) ? json({ digest: digestOf(req.params.id) }) : bad("no such session", 404)),
      // Writes a recap now (the /recap command), whatever the state of the cache.
      POST: async (req: any) => {
        const s = store.session(req.params.id);
        if (!s) return bad("no such session", 404);
        const line = engine.lineage(s.id);
        if (!line.some((e) => e.kind === "assistant")) return bad("nothing to recap yet: the session has no reply", 409);
        let res;
        try {
          res = await engine.ask(s.id, ask(RECAP_PROMPT), req.signal ?? new AbortController().signal);
        } catch (e) {
          const rec = errors.capture("provider", e, { session: s.id, at: "recap" });
          return json({ error: `the recap call failed: ${rec.message}`, error_id: rec.id }, 502);
        }
        // A recap of a branch no longer shown (or of a context a turn has since moved on) is not kept.
        if (store.session(s.id)?.head !== (line.at(-1)?.id ?? null)) return bad("the conversation changed while the recap was written: write it again", 409);
        const d = parseDigest(textOf(res.blocks));
        const digest: Digest = { recap: d.recap, recap_seq: line.at(-1)?.seq ?? 0, next_prompt: d.next, ts_ms: Date.now(), cost_usd: res.usage.cost, model: res.model_id };
        store.db.run("INSERT OR REPLACE INTO session_digests (session_id, data) VALUES (?, ?)", [s.id, JSON.stringify(digest)]);
        bus.emit({ t: "feature", name: "recap", session_id: s.id, data: digest });
        return json({ digest });
      },
    },

    // Summarize a part: `from` a prompt on (the rest before it stays; the prompt's
    // text comes back for the message box), or everything `up_to` it (it and
    // what follows stay verbatim). A new branch or checkpoint; nothing is deleted.
    "/api/sessions/:id/summarize": {
      POST: async (req: any) => {
        const s = store.session(req.params.id);
        if (!s) return bad("no such session", 404);
        if (engine.isRunning(s.id)) return bad("a turn is running: summarize when it has ended", 409);
        const b = ((await req.json().catch(() => null)) ?? {}) as any;
        if (b.direction !== "from" && b.direction !== "up_to") return bad('direction is "from" or "up_to"');
        const focus = typeof b.focus === "string" && b.focus.trim() ? b.focus.trim().slice(0, 2_000) : undefined;
        const line = engine.lineage(s.id);
        const at = line.findIndex((e) => e.id === b.event_id);
        const ev = line[at];
        if (!ev || ev.kind !== "user") return bad("event_id is a prompt on the session's current branch");
        if (at <= checkpointAt(line).at) return bad("that prompt is before the last compaction: the model no longer reads it");
        if (b.direction === "up_to" && !line.slice(0, at).some((e) => e.kind === "assistant")) return bad("nothing before that prompt to summarize");
        const prompt = b.direction === "from" ? PART_FROM(excerpt(ev.data.text), focus) : PART_UP_TO(excerpt(ev.data.text), focus);
        let res;
        try {
          res = await engine.ask(s.id, ask(prompt), new AbortController().signal);
        } catch (e) {
          const rec = errors.capture("provider", e, { session: s.id, at: "summarize" });
          return json({ error: `the summary call failed: ${rec.message}`, error_id: rec.id }, 502);
        }
        const written = textOf(res.blocks);
        if (res.stop === "refusal" || !written) return bad("the model wrote no summary", 502);
        // The later part's statements, checked against what was said in it (the earlier part stays verbatim).
        const summary = b.direction === "from" ? settle(line, written).summary : written;
        if (engine.isRunning(s.id)) return bad("a turn started meanwhile: summarize when it has ended", 409);
        const moved = headMoved(line.at(-1)!.id, store.session(s.id)?.head);
        if (moved) return json({ error: moved.message, code: "head_moved" }, 409);
        const usage = res.usage;
        let head: StoredEvent;
        if (b.direction === "from") {
          // A new branch from before the prompt: the earlier part verbatim, then the summary.
          head = append(s.id, "note", {
            kind: "summary", model: true, summary, from_event: ev.id, replaced_head: line.at(-1)!.id, focus, usage, model_id: res.model_id,
            label: "Summarized from a prompt on; the earlier conversation stays as it was",
            text: `[harness] The owner summarized the later part of this conversation, from their message that began "${excerpt(ev.data.text)}". Summary of that part:\n\n${summary}`,
          }, ev.parent);
        } else {
          // A checkpoint that covers everything before the prompt; the prompt and
          // what follows stay verbatim after the summary.
          const before = line.slice(0, at);
          head = append(s.id, "compaction", {
            mode: "summary", ...checkpointData(before, summary), focus, auto: false, trigger: "owner",
            covered: line[at - 1]!.id, range: "up_to", from_event: ev.id, tokens_before: contextTokens(line, s.model).used, usage, model: res.model_id,
            label: "Summarized everything before a prompt; it and what follows stay as they were",
          });
        }
        emitSession(s.id);
        return json({ summary, head_event_id: head.id, ...(b.direction === "from" ? { prompt_text: ev.data.text } : {}) });
      },
    },

    // One skill kept on as the session's mode (`/skill-mode <name>`); null turns it off.
    "/api/sessions/:id/skill-mode": {
      GET: (req: any) => {
        const s = store.session(req.params.id);
        if (!s) return bad("no such session", 404);
        const skills = discoverSkills(s.workspace).filter((k) => k.userInvocable).map((k) => ({ name: k.name, description: k.description, scope: k.scope }));
        return json({ skill_mode: s.settings.skill_mode ?? null, skills });
      },
      POST: async (req: any) => {
        const s = store.session(req.params.id);
        if (!s) return bad("no such session", 404);
        const b = ((await req.json().catch(() => null)) ?? {}) as any;
        const name = typeof b.skill === "string" && b.skill.trim() ? b.skill.trim().replace(/^\//, "") : null;
        if (name) {
          const r = renderForOwner(name, "", s.workspace, s.id);
          if ("error" in r) return bad(`this session cannot load that skill: ${r.error}`);
        }
        store.mergeSettings(s.id, { skill_mode: name });
        return json({ session: emitSession(s.id) });
      },
    },
  };
};
