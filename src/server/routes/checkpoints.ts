// File checkpoints: list the turns, the diff of a turn or of the session, and
// rewind files to a turn or revert single files.
import { join } from "node:path";
import { registerHooks } from "../../engine/hooks.ts";
import { Bad, Checkpoints, type NoteData, type RewindResult } from "../../safety/checkpoints.ts";
import { leafOf } from "../../core/tree.ts";
import { shownAsPrompt } from "../../core/owner.ts";
import type { Session, StoredEvent } from "../../core/types.ts";
import { folderUse, inUse } from "../inuse.ts";
import type { Deps, RouteModule } from "../app.ts";
import { readsOf } from "../reads.ts";
import { rewindReach } from "./rewind-reach.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status });
const bad = (error: string, status = 400) => json({ error }, status);
const guard = async (f: () => Promise<Response>) => {
  try {
    return await f();
  } catch (e) {
    if (e instanceof Bad) return bad(e.message, e.status);
    throw e;
  }
};

export let checkpoints: Checkpoints | undefined;

export const checkpointRoutes: RouteModule = (deps: Deps) => {
  const { store, engine, errors, bus } = deps;
  const c = (checkpoints = new Checkpoints(store, deps.bus, errors, join(store.stateDir, "checkpoints")));
  const reach = rewindReach(store, c);
  const quiet = (at: string, f: () => unknown) =>
    Promise.resolve().then(f).catch((e) => void errors.capture("server", e, { at }));
  // A store that grew past its budget (or holds sessions that are gone) is trimmed soon after start.
  setTimeout(() => quiet("checkpoint maintenance", () => c.maintain()), 60_000).unref?.();
  // A session whose tools run on another machine has its folder there: nothing here to snapshot.
  registerHooks({
    beforeTool: async (s, call) => void (s.machine || (await quiet("checkpoint before", () => c.before(s, call)))),
    afterTool: async (s, call) => void (s.machine || (await quiet("checkpoint after", () => c.after(s, call)))),
    turnEnd: async (s) => void (s.machine || (await quiet("checkpoint end", () => c.end(s)))),
    branchNote: async (s, line) => (s.machine ? undefined : c.branchNote(s, line)),
    // An edit that also puts the files back: the restore, then (the new version stored) its note.
    restoreFiles: async (s, prompt, o) => {
      if (s.machine) return undefined;
      const turn = c.fileTurn(s, prompt.seq);
      if (turn === undefined) throw Object.assign(new Error("that prompt and what follows changed no files"), { status: 400 });
      const h = await held(s, o.stopShells);
      if (h) throw Object.assign(new Error(((await h.json()) as { error: string }).error), { status: h.status });
      const notes: NoteData[] = [];
      await c.rewind(s, { turn, note: (n) => notes.push(n) });
      return () => { for (const n of notes) bus.emit({ t: "event", event: store.append(s.id, "note", n) }); };
    },
  });

  // A restore while the folder is in use would race what writes there: a turn
  // in or around it (this session's or another's), or a background command of
  // any session whose folder overlaps it (its late write would undo the
  // restore). The owner can have the commands stopped with it (stop_shells).
  // Other idle sessions in the folder do not hold it.
  const held = (s: { id: string; workspace: string }, stopShells: boolean) =>
    inUse(folderUse(store, (x) => engine.isRunning(x), s.workspace, s.id), s.id, { stopShells, what: "rewound", others: false });

  // The chat and the files go back to before one of the branch's prompts (the page's Rewind): `mode` is
  // "both" (the default), "chat" (the head moves to what stood before the prompt; the files stay) or
  // "files" (as the Changes panel's revert, from the prompt's place). The abandoned branch stays as it was, so one Undo
  // (the "rewound" note's id as `undo_rewind`) moves the head back to its end and puts the files back as the restore left them.
  // The files go first, so a refusal (a turn or a command running) leaves the chat where it was.
  const rewindPrompt = async (s: Session, b: any, paths: string[] | undefined, confirm: { paths: string[]; versions: Record<string, string> } | undefined) => {
    const mode: "both" | "chat" | "files" = b.mode === "chat" || b.mode === "files" ? b.mode : "both";
    const prompt = store.lineage(s.id).find((e) => e.id === b.prompt_event);
    if (!prompt || !shownAsPrompt(prompt)) return bad("not a prompt of the branch shown");
    const turn = mode === "chat" && !b.preview ? undefined : c.fileTurn(s, prompt.seq);
    if (b.preview) {
      // What the files would do (nothing, when no turn from this prompt on changed any), and what the turns did that
      // no restore takes back.
      const said = await reach.fromPrompt(s, prompt.seq).catch((e) => (void errors.capture("server", e, { at: "rewind not undone" }), { not_undone: [] }));
      if (turn === undefined) return json({ files: [], failed: [], skipped: [], outside: [], merged: [], conflicts: [], blocked: [], removes: [], uncaptured: [], versions: {}, incomplete: false, undo: null, scope: c.shadow(s.workspace).mode, turn: null, ...said });
      return json({ ...(await c.rewind(s, { turn, preview: true, includeOutside: !!b.include_outside, paths })), turn, ...said });
    }
    if (mode !== "chat" && s.workspace_gone) return bad("the session's folder is gone; move the session to a folder that exists first", 409);
    if (mode === "chat" && engine.isRunning(s.id)) return bad("a turn is running", 409);
    const h = mode === "chat" ? null : await held(s, !!b.stop_shells);
    if (h) return h;
    if (mode !== "chat" && turn === undefined) return bad("that prompt and what follows changed no files");
    const notes: NoteData[] = [];
    const res: RewindResult | null = mode === "chat" ? null : await c.rewind(s, { turn, paths, includeOutside: !!b.include_outside, confirm, note: mode === "both" ? (n) => notes.push(n) : undefined });
    if (mode !== "files") {
      const next = store.updateSession(s.id, { head: prompt.parent });
      bus.emit({ t: "session", session: next });
      for (const n of notes) bus.emit({ t: "event", event: store.append(s.id, "note", n) });
    }
    const words = String(prompt.data.text ?? "").split("\n")[0]!.slice(0, 80);
    const what = mode === "both" ? "the chat and the files" : mode === "chat" ? "the chat" : "the files";
    const mark = store.append(s.id, "note", { kind: "rewound", model: false, mode, from: prompt.id, prompt: words, undo: res?.undo ?? null, files: res?.files.length ?? 0, text: `You rewound ${what} to before "${words}".` });
    bus.emit({ t: "event", event: mark });
    const head = mode === "files" ? undefined : prompt.parent;
    return json({
      files: res, note: mark.id,
      chat: mode === "files" ? null : { head, prompt_text: String(prompt.data.text ?? ""), prompt_images: prompt.data.images?.length ? prompt.data.images : undefined },
    });
  };

  // One Undo for what a rewind did: the files as the restore left them (kept edits made since), and the head
  // back at the end of the branch the rewind left. Not once a newer message was sent.
  const undoRewind = async (s: Session, b: any) => {
    const line = store.lineage(s.id);
    // "last": the newest rewind of the branch shown (the command line has no id to name).
    const at = b.undo_rewind === "last" ? line.findLastIndex((e) => e.kind === "note" && e.data.kind === "rewound") : line.findIndex((e) => e.id === b.undo_rewind);
    const mark = line[at] as StoredEvent | undefined;
    if (!mark || mark.kind !== "note" || mark.data.kind !== "rewound") return bad(b.undo_rewind === "last" ? "no rewind on the branch shown to undo" : "not a rewind of the branch shown");
    if (line.slice(at + 1).some(shownAsPrompt)) return bad("a newer message was sent; the rewind can no longer be undone from here", 409);
    const chat = mark.data.mode !== "files";
    if (engine.isRunning(s.id)) return bad("a turn is running", 409);
    let res: RewindResult | null = null;
    if (mark.data.undo) {
      if (s.workspace_gone) return bad("the session's folder is gone; move the session to a folder that exists first", 409);
      const h = await held(s, !!b.stop_shells);
      if (h) return h;
      // The branch the files return to never heard of the restore: no note there.
      res = await c.rewind(s, { checkpoint: mark.data.undo, quiet: chat });
    }
    let head: string | undefined;
    if (chat) {
      head = leafOf(store.events(s.id), String(mark.data.from));
      const next = store.updateSession(s.id, { head });
      bus.emit({ t: "session", session: next });
    }
    return json({ files: res, head, prompt_text: chat ? String(store.event(String(mark.data.from))?.data.text ?? "") : undefined });
  };

  return {
    "/api/sessions/:id/checkpoints": {
      GET: (req: any) => guard(async () => {
        const s = store.session(req.params.id);
        if (!s) return bad("no such session", 404);
        const sh = c.shadow(s.workspace);
        const { turns, expired } = await c.turns(s);
        // `n`: the turn's place among the session's turns (its first is 1), the number its Tokens panel and
        // `keel cost` give it; `turn` is its start's place in the history, the one a rewind and a diff take.
        // (The starts alone, from the index that holds only those columns, on the read thread.)
        const starts = turns.length ? (await readsOf(store).sql<{ seq: number }>("SELECT seq FROM events INDEXED BY events_bare WHERE session_id = ? AND kind = 'turn_start' ORDER BY seq", [s.id])).map((r) => r.seq) : [];
        const place = new Map(starts.map((seq, i) => [seq, i + 1]));
        const said = await reach.byTurn(s, (turn) => place.get(turn)).catch((e) => (void errors.capture("server", e, { at: "rewind not undone" }), new Map()));
        return json({ turns: turns.map((t) => ({ ...t, ...(place.has(t.turn) ? { n: place.get(t.turn) } : {}), ...(said.get(t.turn)?.length ? { not_undone: said.get(t.turn) } : {}) })), expired, scope: sh.mode, reason: sh.reason ?? null, skipped: sh.skipped.slice(0, 50), skipped_count: sh.skipped.length });
      }),
    },
    // The prompts of the branch shown, all of them (the page holds only the newest part of a long one), and
    // where its turns start: what the Rewind dialog lists. Text is the first line, cut.
    "/api/sessions/:id/prompts": {
      GET: (req: any) => guard(async () => {
        const s = store.session(req.params.id);
        if (!s) return bad("no such session", 404);
        const line = store.lineage(s.id);
        const prompts = line.filter(shownAsPrompt).map((e) => ({ id: e.id, seq: e.seq, text: String(e.data.text ?? "").trim().split("\n")[0]!.slice(0, 200), attachments: (e.data.images?.length ?? 0) > 0 }));
        return json({ prompts, starts: line.filter((e) => e.kind === "turn_start").map((e) => e.seq) });
      }),
    },
    "/api/sessions/:id/checkpoints/diff": {
      GET: (req: any) => guard(async () => {
        const s = store.session(req.params.id);
        if (!s) return bad("no such session", 404);
        const q = new URL(req.url).searchParams;
        const num = (k: string) => (q.has(k) ? Number(q.get(k)) : undefined);
        const paths = q.getAll("path").filter((p) => p && !p.startsWith("/") && !p.split("/").includes(".."));
        return json(await c.diff(s, { turn: num("turn"), from: num("from"), paths: paths.length ? paths : undefined }));
      }),
    },
    "/api/sessions/:id/changes/revert": {
      POST: (req: any) => guard(async () => {
        const s = store.session(req.params.id);
        if (!s) return bad("no such session", 404);
        const b = ((await req.json().catch(() => ({}))) ?? {}) as any;
        if (s.workspace_gone) return bad("the session's folder is gone; move the session to a folder that exists first", 409);
        const h = await held(s, !!b.stop_shells);
        if (h) return h;
        if (typeof b.path !== "string" || !Number.isInteger(b.hunk?.index) || typeof b.hunk?.header !== "string" || typeof b.hunk?.body !== "string" || !Number.isFinite(b.from)) return bad("give path, hunk { index, header, body } and from (the turn)");
        if (b.path.startsWith("/") || b.path.split("/").includes("..")) return bad("the path is relative to the workspace and stays inside it");
        return json(await c.revertHunk(s, { from: Number(b.from), path: b.path, index: b.hunk.index, header: b.hunk.header, body: b.hunk.body }));
      }),
    },
    "/api/sessions/:id/rewind": {
      POST: (req: any) => guard(async () => {
        const s = store.session(req.params.id);
        if (!s) return bad("no such session", 404);
        const b = ((await req.json().catch(() => ({}))) ?? {}) as any;
        if (s.workspace_gone) return bad("the session's folder is gone; move the session to a folder that exists first", 409);
        if (typeof b.undo_rewind === "string") return undoRewind(s, b);
        const paths = Array.isArray(b.paths) ? b.paths.filter((p: unknown) => typeof p === "string") : undefined;
        const confirm = Array.isArray(b.confirm?.paths) && b.confirm.versions && typeof b.confirm.versions === "object"
          ? { paths: b.confirm.paths.filter((p: unknown) => typeof p === "string"), versions: b.confirm.versions as Record<string, string> } : undefined;
        // A turn named by its place in the history (the command line): the prompt it began with.
        if (Number.isInteger(b.prompt_turn) && typeof b.prompt_event !== "string") {
          const turn = b.prompt_turn as number;
          const prompt = store.lineage(s.id).findLast((e) => e.seq < turn && shownAsPrompt(e));
          if (!prompt || c.fileTurn(s, prompt.seq) !== turn) return bad("that turn did not begin with a prompt of the branch shown, so the chat cannot go back to before it; rewind to the turn that did");
          b.prompt_event = prompt.id;
        }
        // From a prompt of the branch shown: the chat, the files, or both go back to before it.
        if (typeof b.prompt_event === "string") return rewindPrompt(s, b, paths, confirm);
        if (typeof b.step === "string" && b.mode && b.mode !== "files") return bad("a step is not a prompt: only the files go back to before it, the chat stays");
        const h = b.preview ? null : await held(s, !!b.stop_shells);
        if (h) return h;
        const res = await c.rewind(s, { turn: b.turn, step: typeof b.step === "string" ? b.step : undefined, checkpoint: b.checkpoint, paths, preview: !!b.preview, includeOutside: !!b.include_outside, confirm });
        // A preview of a revert to before a turn: what that turn and the ones after it did that no restore takes back.
        if (b.preview && Number.isInteger(b.turn)) {
          const said = await reach.fromPrompt(s, b.turn - 1).catch((e) => (void errors.capture("server", e, { at: "rewind not undone" }), undefined));
          if (said) return json({ ...res, not_undone: said.not_undone });
        }
        return json(res);
      }),
    },
  };
};
