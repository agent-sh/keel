// Trust of a repository's own instruction files and skills, and the
// quarantine of protected files a call created or changed. (Hooks and the pin
// of a repository's hook file are in routes/hooks.ts.)
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { registerHooks, type ToolCall } from "../../engine/hooks.ts";
import { instructionFilter } from "../../engine/turn.ts";
import { classifyCall } from "../../safety/gate.ts";
import { Quarantine, snapshot, type Snap } from "../../safety/quarantine.ts";
import { rootOf, Trust } from "../../safety/trust.ts";
import { skillFilter } from "../../tools/skills.ts";
import type { Deps, RouteModule } from "../app.ts";
import { gate, presence } from "./permissions.ts";
import { readText } from "../../core/proc.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status });

// A unified diff of two texts, headed the way the diff view reads it.
async function patchOf(rel: string, a: string, b: string): Promise<{ text: string; added: number; removed: number }> {
  const dir = mkdtempSync(join(tmpdir(), "keel-trust-"));
  try {
    writeFileSync(join(dir, "a"), a);
    writeFileSync(join(dir, "b"), b);
    const p = Bun.spawn(["git", "diff", "--no-index", "--no-color", "-U3", "--", join(dir, "a"), join(dir, "b")], { stdout: "pipe", stderr: "ignore" });
    const out = await readText(p.stdout);
    await p.exited;
    const body = out.split("\n").filter((l) => !/^(diff --git|index |--- |\+\+\+ |new file|deleted file)/.test(l)).join("\n");
    const lines = body.split("\n");
    return { text: `diff --git a/${rel} b/${rel}\n${body}`, added: lines.filter((l) => l.startsWith("+")).length, removed: lines.filter((l) => l.startsWith("-")).length };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const bad = (error: string, status = 400) => json({ error }, status);
// From a remote device, loading a repository's files or putting protected files back needs the owner's passkey.
const needs = (req: Request, action: string) => (!presence || presence.allows(req, action) ? null : json({ error: "this needs your passkey from a remote device", presence: { action } }, 428));

export const trustRoutes: RouteModule = (deps: Deps) => {
  const { store, bus, errors } = deps;
  const trust = new Trust(store);
  const quarantine = new Quarantine(store, join(store.stateDir, "quarantine"));
  instructionFilter.file = (path, text) => trust.instructionText(path, text);
  skillFilter.allow = (dir) => trust.skillAllowed(dir);

  const notify = (sessionId: string, text: string, kind: string) =>
    bus.emit({ t: "event", event: store.append(sessionId, "note", { kind, text }) });

  const snaps = new Map<string, { root: string; snap: Snap }>();

  registerHooks({
    // Once per session (the prompt is frozen): say which of the repository's
    // files wait for the owner.
    system(s) {
      const held = trust.files(s.workspace).filter((f) => f.state === "new" || f.state === "changed");
      if (held.length) {
        notify(s.id, `${held.length} file${held.length === 1 ? "" : "s"} of this repository ${held.length === 1 ? "is" : "are"} held until you trust ${held.length === 1 ? "it" : "them"}: ${held.map((f) => `${relative(f.root, f.path)} (${f.state === "changed" ? "changed" : "new"}${f.kind === "instructions" && f.state === "changed" ? ", the trusted version is used" : ""})`).join(", ")}. Open the Trust panel to read and trust them.`, "trust");
        bus.emit({ t: "feature", name: "trust", session_id: s.id, data: { held: held.length } });
      }
      return "";
    },
    beforeTool(s, call) {
      const cls = classifyCall(call);
      // Protected files are watched around calls the owner does not answer.
      if (cls.kind !== "read" && cls.kind !== "control" && gate?.perm(s.id).mode !== "full-auto") {
        const root = rootOf(s.workspace) ?? s.workspace;
        if (snaps.size > 500) snaps.delete(snaps.keys().next().value!); // calls that failed before afterTool
        snaps.set(call.id, { root, snap: snapshot(root) });
      }
    },
    afterTool(s, call: ToolCall, result) {
      const add = (text: string) => {
        if (typeof result.content === "string") result.content = `${result.content}\n\n${text}`;
        else result.content = [...result.content, { type: "text", text }];
      };
      const before = snaps.get(call.id);
      snaps.delete(call.id);
      if (before && !gate?.ownerAllowed(call.id)) {
        try {
          const b = quarantine.sweep(s.id, before.root, before.snap);
          if (b) {
            add(`Keel moved ${b.paths.length} protected file${b.paths.length === 1 ? "" : "s"} this call created or changed out of the workspace (${b.paths.join(", ")}): they run or configure things outside the sandbox later, so only the owner adds them. A changed one has its previous content back. The owner can restore them.`);
            notify(s.id, `Moved to quarantine: ${b.paths.join(", ")}. Restore or discard them in the Trust panel.`, "quarantine");
            bus.emit({ t: "feature", name: "quarantine", session_id: s.id, data: b });
          }
        } catch (e) {
          errors.capture("server", e, { at: "quarantine sweep", session: s.id });
        }
      }
    },
  });

  const body = async (req: Request) => ((await req.json().catch(() => ({}))) ?? {}) as any;
  const dirOf = (raw: string | null | undefined) => {
    const cwd = resolve(raw || deps.workspace);
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw Object.assign(new Error(`not a directory: ${cwd}`), { status: 400 });
    return cwd;
  };
  const view = (cwd: string) => {
    const files = trust.files(cwd).map((f) => ({ ...f, rel: relative(f.root, f.path) || f.path }));
    return { root: rootOf(cwd), new_files: trust.newFiles(), files };
  };
  const guard = (f: () => Response | Promise<Response>) => async () => {
    try { return await f(); } catch (e) {
      const st = (e as any).status;
      if (st) return bad((e as Error).message, st);
      throw e;
    }
  };

  return {
    "/api/trust": {
      GET: (req: any) => guard(() => json(view(dirOf(new URL(req.url).searchParams.get("cwd")))))(),
      // Trust files at the content the owner was shown: { cwd, files: [{ path, sha256 }] }.
      POST: async (req: any) => guard(async () => {
        const g = needs(req, "trust");
        if (g) return g;
        const b = await body(req);
        const cwd = dirOf(b.cwd);
        const list = Array.isArray(b.files) ? b.files : b.path ? [{ path: b.path, sha256: b.sha256 }] : [];
        if (!list.length) return bad("name the files to trust, each with the sha256 you were shown");
        for (const f of list) trust.trust(cwd, String(f.path), String(f.sha256 ?? ""));
        bus.emit({ t: "feature", name: "trust", data: { cwd } });
        return json(view(cwd));
      })(),
    },
    "/api/trust/settings": {
      GET: () => json({ new_files: trust.newFiles() }),
      PUT: async (req: any) => {
        const b = await body(req);
        if (b.new_files !== "auto" && b.new_files !== "ask") return bad('new_files is "auto" or "ask"');
        trust.setNewFiles(b.new_files);
        return json({ new_files: trust.newFiles() });
      },
    },
    // The texts to compare before trusting: the one last trusted and the one now.
    "/api/trust/diff": {
      GET: (req: any) => guard(async () => {
        const q = new URL(req.url).searchParams;
        const cwd = dirOf(q.get("cwd"));
        const f = trust.files(cwd).find((x) => x.path === q.get("path"));
        if (!f) return bad("no such project file in that folder", 404);
        const now = f.kind === "skill" ? (existsSync(join(f.path, "SKILL.md")) ? readFileSync(join(f.path, "SKILL.md"), "utf8") : "") : existsSync(f.path) ? readFileSync(f.path, "utf8") : "";
        const pinned = trust.pinnedText(f.path);
        const rel = relative(f.root, f.kind === "skill" ? join(f.path, "SKILL.md") : f.path);
        return json({ path: f.path, rel, kind: f.kind, state: f.state, sha256: f.sha256, pinned, current: now.slice(0, 200_000), patch: await patchOf(rel, pinned ?? "", now) });
      })(),
    },
    "/api/permissions/quarantine": {
      GET: (req: any) => {
        const sid = new URL(req.url).searchParams.get("session");
        return json({ batches: quarantine.list(sid ?? undefined) });
      },
    },
    "/api/permissions/quarantine/:id": {
      GET: (req: any) => guard(() => json({ text: quarantine.read(req.params.id, new URL(req.url).searchParams.get("path") ?? "") }))(),
      DELETE: (req: any) => guard(() => {
        const b = quarantine.discard(req.params.id);
        bus.emit({ t: "feature", name: "quarantine", session_id: b.session_id, data: b });
        return json({ ok: true, batch: b });
      })(),
    },
    "/api/permissions/quarantine/:id/restore": {
      POST: (req: any) => guard(() => {
        const g = needs(req, `quarantine:${req.params.id}`);
        if (g) return g;
        const b = quarantine.restore(req.params.id);
        bus.emit({ t: "feature", name: "quarantine", session_id: b.session_id, data: b });
        return json({ ok: true, batch: b });
      })(),
    },
  };
};
