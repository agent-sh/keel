// The rewind route refuses while a turn runs in the same folder, however the
// two sessions spell it: a link to the folder is the folder.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Bus } from "../../core/bus.ts";
import { ErrorTracker } from "../../core/errors.ts";
import { Store } from "../../core/store.ts";
import { allHooks } from "../../engine/hooks.ts";
import { checkpointRoutes, checkpoints } from "./checkpoints.ts";

const root = join(process.env.HOME!, ".cache/keel-work/bun/unit", `ckpt-route-${process.pid}`);
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("a rewind is refused while another session works in the same folder through a link", async () => {
  for (const linked of ["busy", "target"] as const) {
    const base = join(root, linked);
    const real = join(base, "real"), alias = join(base, "alias");
    mkdirSync(real, { recursive: true });
    symlinkSync(real, alias, "dir");
    const store = new Store(join(base, "state"));
    const hooks = allHooks().length; // the routes register tool hooks on this store: taken off before it closes
    const bus = new Bus();
    const target = linked === "target" ? alias : real;
    const s = store.createSession({ workspace: target, model: "m", title: "rewind" });
    const other = store.createSession({ workspace: linked === "busy" ? alias : real, model: "m", title: "working" });
    const routes = checkpointRoutes({ store, bus, errors: new ErrorTracker(store, bus), engine: { isRunning: (id: string) => id === other.id } } as any) as any;
    writeFileSync(join(real, "note.txt"), "alpha\n");
    store.append(s.id, "user", { text: "edit" });
    const turn = store.append(s.id, "turn_start", {}).seq;
    const call = { id: "c", tool: { name: "Edit", kind: "edit", readOnly: false }, input: { file_path: join(target, "note.txt") }, ctx: { cwd: target, sessionId: s.id } } as any;
    await checkpoints!.before(s, call);
    writeFileSync(join(real, "note.txt"), "beta\n");
    await checkpoints!.after(s, call);
    await checkpoints!.end(s);
    const req = Object.assign(new Request(`http://x/api/sessions/${s.id}/rewind`, { method: "POST", body: JSON.stringify({ turn }), headers: { "content-type": "application/json" } }), { params: { id: s.id } });
    const res = await routes["/api/sessions/:id/rewind"].POST(req);
    expect(res.status).toBe(409);
    expect(readFileSync(join(real, "note.txt"), "utf8")).toBe("beta\n");
    allHooks().splice(hooks);
    store.db.close();
  }
});
