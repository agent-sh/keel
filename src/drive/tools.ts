// The drive tools, deferred: a session finds them with search_tools and runs
// them with mcp_call, so they cost nothing on a request until one is used.
// Each acting tool judges its target first (the gate reads that judgement):
// a send into an open prompt is refused before any card is raised, and what
// only the owner may send is marked so no mode covers it.
import type { Store } from "../core/store.ts";
import type { Session } from "../core/types.ts";
import type { Providers } from "../providers/registry.ts";
import type { CallClass } from "../safety/policy.ts";
import type { CatalogTool } from "../tools/catalog.ts";
import { OUTPUT_CAP } from "../tools/spill.ts";
import { fail, ok, type ToolOutput } from "../tools/types.ts";
import { DriveError, modelCommand, type Drive, type Found } from "./drive.ts";
import { pickChoice } from "./text.ts";
import { farSent, noteSent } from "./sent.ts";

const fmt = (e: unknown): ToolOutput => fail(e instanceof DriveError ? `Error [${e.code}]: ${e.message}` : `Error: ${(e as Error).message}`);

export function driveTools(drive: Drive, store: Store, providers: Providers): CatalogTool[] {
  // The row each call was judged on, so the act goes to the session as judged.
  const judged = new WeakMap<object, Found>();

  const t = (name: string, description: string, properties: Record<string, unknown>, required: string[], readOnly: boolean, run: CatalogTool["run"], judge?: (i: any) => Promise<CallClass>): CatalogTool => ({
    server: "keel", name, qualified: `keel__${name}`, description, readOnly, judge,
    input_schema: { type: "object", properties, required, additionalProperties: false }, run,
  });

  // Words a model is about to put at another session's prompt, kept as digests before they go (src/drive/sent.ts),
  // and told to the Keel of the machine the session runs on (nothing is sent when that Keel cannot be reached; a Keel
  // too old to keep them is told once it can, src/drive/sent.ts farSent). A send beside an unsent draft in the
  // session's input box is refused (drive.held refuses it again just before it goes); when the box could not be read
  // empty, the words are kept loosely (sent-read.ts keysInto). A note after an answer is not refused here: the box
  // is under the prompt then, and the drive reads it again before the note goes.
  const sent = async (f: Found, text: string, note = false) => {
    const box = await drive.box(f);
    if (box === "draft" && !note) throw new DriveError("NOT_SENT", `"${f.row.name}" holds an unsent draft in its input box: a text sent now would go out inside it. Send once the box is empty. Nothing was sent.`);
    const digests = noteSent(store, text, box !== "empty");
    if (f.host) {
      try { await farSent(store, f.host, digests); } catch (e) { throw new DriveError("NOT_SENT", `the Keel on ${f.host} could not be told what is sent (${(e as Error).message}). Nothing was sent.`); }
    }
  };

  // A judgement that refuses with the reason rather than throws.
  const judging = (tool: string, f: (i: any) => Promise<Omit<Extract<CallClass, { kind: "drive" }>, "kind" | "resource">>) => async (i: any): Promise<CallClass> => {
    try {
      const d = await f(i);
      return { kind: "drive", resource: `keel__${tool}:${d.target}`, ...d };
    } catch (e) {
      return { kind: "refused", why: e instanceof DriveError ? `Error [${e.code}]: ${e.message}` : (e as Error).message };
    }
  };

  // Budget of a read: one percent of the driving model's window at four bytes
  // a token (the share a skill listing gets), never past the inline tool cap.
  const budget = async (sessionId: string) => {
    const s: Session | undefined = store.session(sessionId);
    const info = s ? await providers.resolve(s.model).then((r) => r.info, () => null) : null;
    return info?.context ? Math.min(OUTPUT_CAP, Math.max(4000, Math.round(info.context * 0.01 * 4))) : 8000;
  };

  const target = async (id: unknown, i: object) => {
    if (typeof id !== "string" || !id) throw new DriveError("INVALID_PARAM", "give the session id from keel__sessions_all");
    const f = await drive.find(id);
    judged.set(i, f);
    return f;
  };

  return [
    t("sessions_all",
      "List the owner's agent sessions of other harnesses on this machine and the machines the agent view links (Claude Code, Codex, agy), live and recently ended, with state, model, folder and what each can be driven with. changed marks rows new or different since this session's previous list.",
      { kind: { type: "string", enum: ["claude", "codex", "agy"] }, host: { type: "string" }, changed_only: { type: "boolean" } }, [], true,
      async (i, ctx) => {
        const r = await drive.list();
        const inScope = (x: { kind: string; host?: string | null }) => (!i.kind || x.kind === i.kind) && (!i.host || x.host === i.host);
        let rows = drive.markChanged(ctx.sessionId, r.sessions, inScope).filter(inScope);
        if (i.changed_only) rows = rows.filter((x) => x.changed);
        const slim = rows.map(({ transcript: _t, ...x }) => Object.fromEntries(Object.entries(x).filter(([, v]) => v !== null && v !== "")));
        return ok(JSON.stringify(r.not_listed ? { sessions: slim, not_listed: r.not_listed } : { sessions: slim }));
      }),
    t("session_read",
      "Read another session before acting on it: its newest turns (from its transcript) or screen lines, then its open prompt as PENDING <kind> request=<id> hash=<16 hex> with what it asks. Older entries are left out first to fit the read's budget.",
      { id: { type: "string" }, n: { type: "integer", description: "turns or screen lines, default 80" } }, ["id"], true,
      async (i, ctx) => {
        try {
          return ok((await drive.read(i.id, { lines: i.n, budget: await budget(ctx.sessionId) })).text);
        } catch (e) {
          return fmt(e);
        }
      }),
    t("session_message",
      "Send a message to another session; an ended one is resumed with it. Held while the session waits on a prompt (answer it with keel__session_answer). A line starting with ! / or -, an @ mention, a $ mention for Codex, and any text for an ended session go to the owner to send.",
      { to: { type: "string" }, text: { type: "string" } }, ["to", "text"], false,
      async (i) => {
        try {
          const f = judged.get(i) ?? (await drive.find(i.to));
          await sent(f, String(i.text ?? ""));
          return ok(await drive.send(i.to, String(i.text ?? ""), f));
        } catch (e) {
          return fmt(e);
        }
      },
      judging("session_message", async (i) => {
        const f = await target(i.to, i);
        if (!f.row.drive.send) throw new DriveError("NOT_AVAILABLE", `that session is ${f.row.state} and takes no message`);
        const { body, owner } = drive.judgeText(f, String(i.text ?? ""));
        const why = await drive.held(f);
        if (why) throw new DriveError("NOT_SENT", `${why}. Nothing was sent.`);
        return { target: f.row.id, owner, shown: `${f.row.live ? "Message" : "Resume"} ${f.row.name} (${f.row.kind}, ${f.row.state}):\n${body.text}` };
      })),
    t("session_answer",
      "Answer another session's open prompt with one of its options, naming the request and hash keel__session_read showed. An allow goes to the owner; a note is sent after the answer as a message of its own.",
      { id: { type: "string" }, request: { type: "string" }, hash: { type: "string" }, decision: { type: "string", enum: ["allow", "deny"] }, choice: { type: "string" }, note: { type: "string" } },
      ["id", "request", "hash", "decision"], false,
      async (i) => {
        try {
          const f = judged.get(i) ?? (await drive.find(i.id));
          if (typeof i.note === "string") await sent(f, i.note, true);
          return ok(await drive.answer(i.id, i, f));
        } catch (e) {
          return fmt(e);
        }
      },
      judging("session_answer", async (i) => {
        if (i.decision !== "allow" && i.decision !== "deny") throw new DriveError("INVALID_PARAM", "decision is allow or deny");
        const f = await target(i.id, i);
        const p = await drive.prompt(f);
        if (!p || p.id !== i.request || p.hash !== i.hash) throw new DriveError("CHANGED", "the open prompt is not the one you read (request or hash differ). Nothing was answered; read the session again.");
        const pick = (() => {
          try {
            return pickChoice(p, i.decision, i.choice);
          } catch (e) {
            throw new DriveError("INVALID_PARAM", `${(e as Error).message}. Nothing was answered.`);
          }
        })();
        const note = i.note?.trim() ? drive.judgeText(f, i.note) : undefined;
        const owner = pick.allows ? "an allow on another session's prompt lets that session act; it is the owner's answer" : note?.owner;
        return { target: f.row.id, owner, shown: `${i.decision} (option ${pick.value} = ${pick.label}) on ${f.row.name}:\n${p.title ?? ""}\n${p.body ?? ""}${note ? `\n\nthen send the note:\n${note.body.text}` : ""}` };
      })),
    t("session_model",
      "Switch a live session of another harness to another model by sending its own /model <name> command. Held while it waits on a prompt.",
      { id: { type: "string" }, model: { type: "string" } }, ["id", "model"], false,
      async (i) => {
        try {
          // The command is words at the session's prompt too: kept as sent before it goes.
          const f = judged.get(i) ?? (await drive.find(i.id));
          const name = String(i.model ?? "").trim();
          if (name && !/\s/.test(name) && f.row.drive.model) await sent(f, modelCommand(f.row.kind, name).text);
          return ok(await drive.model(i.id, String(i.model ?? ""), f));
        } catch (e) {
          return fmt(e);
        }
      },
      judging("session_model", async (i) => {
        const f = await target(i.id, i);
        if (!f.row.drive.model) throw new DriveError("NOT_AVAILABLE", `that session is ${f.row.state}; a model command goes only into a live session`);
        const cmd = modelCommand(f.row.kind, String(i.model ?? "").trim());
        const why = await drive.held(f);
        if (why) throw new DriveError("NOT_SENT", `${why}. The model was not changed.`);
        return { target: f.row.id, shown: `In ${f.row.name} (${f.row.kind}), send:\n${cmd.text}` };
      })),
    t("session_resume",
      "Resume an ended session of another harness with a first message. The text goes to its harness as a command-line argument, so the owner sends it.",
      { id: { type: "string" }, text: { type: "string" } }, ["id", "text"], false,
      async (i) => {
        try {
          const f = judged.get(i) ?? (await drive.find(i.id));
          if (!f.row.drive.resume) throw new DriveError("NOT_AVAILABLE", `that session is ${f.row.state} and cannot be resumed by the agent view`);
          await sent(f, String(i.text ?? ""));
          return ok(await drive.send(i.id, String(i.text ?? ""), f));
        } catch (e) {
          return fmt(e);
        }
      },
      judging("session_resume", async (i) => {
        const f = await target(i.id, i);
        if (!f.row.drive.resume) throw new DriveError("NOT_AVAILABLE", `that session is ${f.row.state} and cannot be resumed by the agent view`);
        const { body, owner } = drive.judgeText(f, String(i.text ?? ""));
        return { target: f.row.id, owner, shown: `Resume ${f.row.name} (${f.row.kind}) with:\n${body.text}` };
      })),
  ];
}
