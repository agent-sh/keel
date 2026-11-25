// What another daemon's frames become here: every session id they carry, at
// the top or inside the payload, names that daemon's session.
import { expect, test } from "bun:test";
import type { Frame, Session } from "../../../src/core/types.ts";
import { asRemote, machineApi, ownId, relayed } from "./fleet-ids.ts";

test("queue and status frames of a peer session are kept, under its id here", () => {
  expect(relayed("aa", { t: "queue", session_id: "s", queue: [], held: true })).toEqual({ t: "queue", session_id: "aa--s", queue: [], held: true });
  const st = { t: "status", session_id: "s", status: { kind: "retry", attempt: 1, max: 3, at: 5, message: "busy" } } as Frame;
  expect(relayed("aa", st)).toEqual({ ...st, session_id: "aa--s" } as Frame);
});

test("a peer child's parent is the peer's session", () => {
  const kid = { id: "kid", parent_id: "parent" } as Session;
  expect(asRemote("aa", kid)).toMatchObject({ id: "aa--kid", parent_id: "aa--parent", machine: "aa" });
  expect(asRemote("aa", { id: "root", parent_id: null } as unknown as Session).parent_id).toBeNull();
});

test("an automation update names the peer's session inside its payload", () => {
  const tasks = relayed("bb", { t: "feature", name: "automation", data: { kind: "tasks", data: { session_id: "shared", tasks: [1] } } });
  expect(tasks).toMatchObject({ data: { kind: "tasks", data: { session_id: "bb--shared", tasks: [1] } } });
  const agent = relayed("bb", { t: "feature", name: "automation", data: { kind: "agent", data: { id: "x", parent_id: "p" } } });
  expect(agent).toMatchObject({ data: { data: { id: "x", parent_id: "bb--p" } } });
  // An update with no session in it passes as it is.
  const tick = { t: "feature", name: "automation", data: { kind: "activity", data: {} } } as Frame;
  expect(relayed("bb", tick)).toEqual({ ...tick, session_id: undefined } as Frame);
});

test("a path about a session's folder goes to the machine that holds it", () => {
  expect(machineApi("aa--s1", "/api/trust?cwd=%2Fw")).toBe("/api/fleet/machines/aa/api/trust?cwd=%2Fw");
  expect(machineApi("s1", "/api/trust?cwd=%2Fw")).toBe("/api/trust?cwd=%2Fw");
  expect(ownId("aa--s1")).toBe("s1");
  expect(ownId("s1")).toBe("s1");
});
