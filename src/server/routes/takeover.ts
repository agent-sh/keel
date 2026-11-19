// Taking over a session another harness runs, and copying one from the drive
// list: POST /api/import/takeover and GET /api/import/running for the owner,
// keel__session_import for a model (a take-over is a card only the owner
// answers; a copy is judged like a send).
import { sharedDrive, DriveError, type Found } from "../../drive/drive.ts";
import { HttpError, TakeOver, type Answer } from "../../drive/takeover.ts";
import { sharedImports } from "../../integrations/import/service.ts";
import { registerCatalog, type CatalogTool } from "../../tools/catalog.ts";
import { fail, ok } from "../../tools/types.ts";
import type { CallClass } from "../../safety/policy.ts";
import type { Deps, RouteModule } from "../app.ts";
import { presence } from "./permissions.ts";

export let takeover: TakeOver | undefined;

const json = (data: unknown, status = 200) => Response.json(data, { status });
const bad = (error: string, status = 400) => json({ error }, status);

// What an import or a take-over came to, for the model.
export function answerText(name: string, d: Answer): string {
  const sid = d.session?.id ?? "?";
  const told = d.told === false ? " The copy was not told so: a turn runs in it." : " The copy was told so in its own transcript.";
  const left = [
    d.left_behind?.running ? ` Still in flight there: ${d.left_behind.running}.` : "",
    d.left_behind?.jobs.length ? ` Its scheduled jobs (${d.left_behind.jobs.map((j) => `\`${j.cron}\``).join(", ")}) do not carry over; recreate them with keel__loop_create once the original has ended.` : "",
  ].join("");
  const gap = !d.not_copied ? ""
    : d.not_copied.messages === 0 ? " The Keel session went on since it was copied; the original wrote nothing after that."
    : d.not_copied.messages === null ? ` What the original wrote after the copy is not in the Keel session and could not be counted; its transcript is ${d.not_copied.transcript}.`
    : ` The Keel session went on since it was copied, so ${d.not_copied.messages} of the original's messages after that are not in it; they are in ${d.not_copied.transcript}.`;
  const line =
    d.action === "taken_over" && d.stopped ? `Took over "${name}": it was ended where it ran${d.how ? ` (${d.how})` : ""} and goes on as Keel session ${sid} (${d.imported_events} events copied).${gap}${left}`
    : d.action === "taken_over" ? `"${name}" had ended; it goes on as Keel session ${sid} (${d.imported_events} events copied).${gap}`
    : d.action === "snapshot" ? `Keel copied "${name}" as session ${sid}, and it still runs where it ran. ${d.step ?? ""}${told}${left}`
    : d.action === "opened" ? `"${name}" is Keel session ${sid}, as it was.`
    : d.action === "updated" ? `Keel session ${sid} was brought up to date with "${name}" (${d.imported_events} events added).`
    : `"${name}" was imported as Keel session ${sid} (${d.imported_events} events).`;
  return d.live_source ? `${line} It still runs where it ran.${told}${left}` : line;
}

export const takeoverRoutes: RouteModule = (deps: Deps) => {
  const drive = sharedDrive();
  const imports = sharedImports(deps.store);
  const t = (takeover = new TakeOver(deps, drive, imports));
  const body = async (req: Request) => ((await req.json().catch(() => ({}))) ?? {}) as any;

  const judged = new WeakMap<object, Found>();
  const tool: CatalogTool = {
    server: "keel", name: "session_import", qualified: "keel__session_import",
    description: "Copy a Claude Code or Codex session (an id from keel__sessions_all) into Keel: a new Keel session the first time, the Keel session made before brought up to date after that. take_over: true also ends the original where it runs and goes on in Keel; only the owner allows that, and a session at work or on a prompt is copied, not ended. The Keel session runs on the model named, else on this session's.",
    readOnly: false,
    input_schema: {
      type: "object", additionalProperties: false, required: ["id"],
      properties: {
        id: { type: "string" },
        take_over: { type: "boolean", description: "End the original where it runs and go on in Keel. Default false: only copy it." },
        mode: { type: "string", enum: ["new", "update", "open"], description: "Without take_over: new makes a second copy, update brings the copy up to date, open returns it as it is." },
        model: { type: "string", description: "The model the Keel session runs on; default this session's." },
      },
    },
    async judge(i: any): Promise<CallClass> {
      try {
        if (typeof i.id !== "string" || !i.id) throw new DriveError("INVALID_PARAM", "give the session id from keel__sessions_all");
        if (i.take_over && i.mode) throw new DriveError("INVALID_PARAM", "a take-over always brings the Keel copy up to date; leave out mode");
        if (i.mode && !["new", "update", "open"].includes(i.mode)) throw new DriveError("INVALID_PARAM", `unknown mode ${i.mode}; one of new, update, open`);
        const f = await drive.find(i.id);
        t.sourceOf(f);
        judged.set(i, f);
        const shown = i.take_over
          ? `take over the ${f.row.kind} session "${f.row.name}" (${f.row.state}): end it where it runs and continue it in Keel`
          : `copy the ${f.row.kind} session "${f.row.name}" into Keel${i.mode ? ` (mode ${i.mode})` : ""}`;
        return { kind: "drive", target: f.row.id, resource: `keel__session_import:${f.row.id}`, shown, owner: i.take_over ? "a take-over ends a session the owner runs elsewhere" : undefined };
      } catch (e) {
        return { kind: "refused", why: e instanceof DriveError ? `Error [${e.code}]: ${e.message}` : `Error [NOT_AVAILABLE]: ${(e as Error).message}` };
      }
    },
    async run(i: any, ctx) {
      try {
        const f = judged.get(i) ?? (await drive.find(i.id));
        const model = i.model || deps.store.session(ctx.sessionId)?.model;
        if (i.take_over) return ok(answerText(f.row.name, await t.takeOver({ session: f.row.id, model })));
        const c = await t.copy(t.sourceOf(f), { model, mode: i.mode });
        const d: Answer = { ...c, notes: c.notes };
        if (f.raw.live === true && f.raw.stale !== true && c.session) {
          d.live_source = true;
          const had = !!imports.liveSource(c.session.id);
          if (!had) {
            const b = await t.tellLive(c.session.id, f, null);
            d.told = b.told;
            if (b.jobs.length || b.running) d.left_behind = { jobs: b.jobs, running: b.running };
          }
        }
        return ok(answerText(f.row.name, d));
      } catch (e) {
        return fail(`Error [NOT_IMPORTED]: ${(e as Error).message}`);
      }
    },
  };
  registerCatalog({ name: "keel-import", tools: async () => (drive.configured() ? [tool] : []) });

  return {
    "/api/import/running": {
      GET: async () => json(await t.running()),
    },
    "/api/import/takeover": {
      POST: async (req: Request) => {
        if (presence && !presence.allows(req, "takeover")) return json({ error: "this needs your passkey from a remote device", presence: { action: "takeover" } }, 428);
        const b = await body(req);
        if (!b.session && !b.path && !(b.harness && b.id)) return bad("name the session: session (from the drive list), harness and id, or path");
        if (b.harness && !["claude", "codex"].includes(b.harness)) return bad(`unknown harness ${b.harness}`);
        try {
          const d = await t.takeOver({ session: b.session, harness: b.harness, id: b.id, path: b.path, model: b.model, title: b.title });
          return json(d);
        } catch (e) {
          if (e instanceof HttpError) return bad(e.message, e.status);
          deps.errors.capture("server", e, { at: "takeover" });
          return bad((e as Error).message, 500);
        }
      },
    },
  };
};
