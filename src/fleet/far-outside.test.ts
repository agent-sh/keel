import { expect, test } from "bun:test";
import { Bus } from "../core/bus.ts";
import type { MachineRow } from "./db.ts";
import { LinkError } from "./link.ts";
import { FarOutside, farSessions, type FarRunning } from "./far-outside.ts";

const row = (over: Partial<FarRunning> = {}): FarRunning => ({
  harness: "claude", id: "6f6f6f6f-1000-4000-8000-000000000001", path: "/box/.claude/projects/-w/x.jsonl", cwd: "/box/work",
  title: "Name the fruit", first_prompt: "a secret prompt", last_prompt: "another secret", updated_ms: 1_000, size_bytes: 10,
  kind: "interactive", original: { state: "idle", brief: "idle" }, ...over,
});
const ON = { enabled: true, exclude: [] as string[] };

test("a running list becomes read-only rows: harness, title, folder and state, no words of the session", () => {
  const [s, ...rest] = farSessions([
    row(),
    row({ id: "b", harness: "codex", updated_ms: 3_000, original: { state: "active", brief: "1 call" } }),
    row({ id: "c", updated_ms: 2_000, original: { state: "active", brief: "on a prompt" } }),
  ], ON);
  expect([s, ...rest].map((x) => [x!.id, x!.outside!.harness, x!.outside!.state, x!.phase])).toEqual([
    ["outside-codex-b", "codex", "working", "working"],
    ["outside-claude-c", "claude", "waiting", "idle"],
    ["outside-claude-6f6f6f6f-1000-4000-8000-000000000001", "claude", "done", "idle"],
  ]);
  const done = rest[1]!;
  expect(done.title).toBe("Name the fruit");
  expect(done.workspace).toBe("/box/work");
  expect(done.outside!.source_id).toBe("6f6f6f6f-1000-4000-8000-000000000001");
  // Nothing it said is in the row.
  expect(JSON.stringify([s, ...rest])).not.toContain("secret");
});

test("only interactive sessions its harness holds open, outside excluded folders, while outside sessions are on", () => {
  const rows = [
    row({ id: "a" }),
    row({ id: "script", kind: "headless" }),
    row({ id: "ended", original: undefined }),
    row({ id: "away", cwd: "/box/private/x" }),
    row({ id: "agy", harness: "agy" as FarRunning["harness"] }),
    row({ id: "a" }),
  ];
  expect(farSessions(rows, { enabled: true, exclude: ["/box/private"] }).map((s) => s.outside!.source_id)).toEqual(["a"]);
  expect(farSessions(rows, { enabled: false, exclude: [] })).toEqual([]);
});

const machine = (over: Partial<MachineRow>): MachineRow => ({
  id: "m1", name: "box", source: "ssh", daemon_url: null, ssh_host: "box", daemon_port: null, workspace_root: "/box", auto_connect: 1, colour: null,
  messages: "allow", max_jobs: null, link_daemon_id: null, link_key: null, facts: null, state: "ready", reason: null, checked_ms: null, created: 0, offline_since: null, ...over,
});

test("asks only the ssh machines that answer, and tells the pages once a change", async () => {
  const machines = [machine({}), machine({ id: "m2", state: "offline" }), machine({ id: "m3", source: "daemon", daemon_url: "http://x" })];
  let answer: FarRunning[] = [row()];
  const asked: string[] = [];
  const failures: unknown[] = [];
  const bus = new Bus();
  const frames: string[] = [];
  bus.on((f) => { if (f.t === "feature" && f.name === "fleet_outside") frames.push(f.data.machine); });
  const far = new FarOutside({
    fleet: {
      rows: () => machines,
      isSsh: (m) => m.source === "ssh" && !m.daemon_port,
      handsJson: async <T,>(id: string, path: string) => { asked.push(`${id} ${path}`); if (answer === null) throw new LinkError("gone"); return { sessions: answer } as T; },
    },
    bus, heard: () => true, capture: (e) => failures.push(e), settings: () => ON,
  });
  await far.poll();
  expect(asked).toEqual(["m1 /api/fleet/hands/transcripts?running=1&peek=1&limit=50"]);
  expect(far.sessions("m1").map((s) => s.outside!.source_id)).toEqual([row().id]);
  expect(frames).toEqual(["m1"]);
  await far.poll(); // the same list: nothing to tell
  expect(frames).toEqual(["m1"]);
  answer = [];
  await far.poll();
  expect(frames).toEqual(["m1", "m1"]);
  expect(far.sessions("m1")).toEqual([]);
  // Out of reach: the rows stand as last told, and it is no failure of Keel's.
  answer = [row()];
  await far.poll();
  answer = null as unknown as FarRunning[];
  await far.poll();
  expect(far.sessions("m1")).toHaveLength(1);
  expect(failures).toEqual([]);
  expect(far.sessions("m2")).toEqual([]);
});
