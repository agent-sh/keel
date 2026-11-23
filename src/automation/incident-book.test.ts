import { expect, test } from "bun:test";
import { bodyOf, IncidentBook, lineOf, owesAlert, QUIET_MS, radiusOf, titleOf, wentDownByItself, type Hit } from "./incident-book.ts";

const T0 = 1_800_000_000_000;
let n = 0;
const book = () => new IncidentBook(() => `inc-${++n}`);
const fail = (at: number, id: string, parent: string | null, message = "Provider: Unable to connect. Is the computer able to access the url?"): Hit =>
  ({ key: "provider:p", cause: "provider", label: "Provider", cls: "unreachable", at, message, session: { id, title: id, parent }, failed: true });

test("nine agents and their parent failing on one provider within a minute are one incident, from the second session", () => {
  const b = book();
  // One failure is the session's own.
  expect(b.hit(fail(T0, "a1", "coord"))).toBeUndefined();
  const i = b.hit(fail(T0 + 11_000, "a2", "coord"))!;
  expect(i).toBeDefined();
  expect(i.since).toBe(T0);
  for (let k = 3; k <= 9; k++) expect(b.hit(fail(T0 + k * 4_000, `a${k}`, "coord"))!.id).toBe(i.id);
  for (let t = 0; t < 4; t++) b.hit(fail(T0 + 30_000 + t * 60_000, "coord", null));
  expect(b.list()).toHaveLength(1);
  expect(i.touched.filter((t) => t.parent === "coord")).toHaveLength(9);
  expect(i.touched.find((t) => t.id === "coord")!.n).toBe(4);
  expect(i.failed).toBe(13);
  expect(titleOf(i)).toBe("Provider cannot be reached");
  expect(radiusOf(i)).toBe("9 agents and 1 session: 13 turns failed");
  // Work failed: the owner is told at once, once.
  expect(owesAlert(i)).toBe(true);
  i.notified = T0;
  expect(owesAlert(i)).toBe(false);
  // The parent's failure alert of the incident's class is the incident's to tell; another session's,
  // or one of another class, is not.
  expect(b.absorbs("coord", "unreachable", T0 + 4 * 60_000)?.id).toBe(i.id);
  expect(b.absorbs("coord", "context_overflow", T0 + 4 * 60_000)).toBeUndefined();
  expect(b.absorbs("coord", undefined, T0 + 4 * 60_000)).toBeUndefined();
  expect(b.absorbs("elsewhere", "unreachable", T0 + 60_000)).toBeUndefined();
  // A turn on it that went through ends it.
  const c = b.clear("provider:p", "it answers again", T0 + 5 * 60_000)!;
  expect(c.cleared).toBe(T0 + 5 * 60_000);
  expect(lineOf(c)).toBe("Provider cannot be reached (cleared: it answers again). 9 agents and 1 session: 13 turns failed.");
  expect(b.list()).toHaveLength(0);
  expect(b.cleared()[0]!.id).toBe(i.id);
});

test("failures further apart than the window, or of one session twice, are no incident", () => {
  const b = book();
  expect(b.hit(fail(T0, "a", null))).toBeUndefined();
  expect(b.hit(fail(T0 + 3 * 60_000, "b", null))).toBeUndefined();
  expect(b.hit(fail(T0 + 3 * 60_000 + 1, "b", null))).toBeUndefined();
  // A third of one session within the window is a repeat of a cause, not chance.
  expect(b.hit(fail(T0 + 3 * 60_000 + 2, "b", null))).toBeDefined();
});

test("a held wait is an incident at once, is told only when it lasts, and clears when the provider answers", () => {
  const b = book();
  const wait = (sessions: string[], at: number, long = false) => b.held({ key: "provider:p", label: "Provider", since: T0, message: "ConnectionRefused", sessions: sessions.map((id) => ({ id, title: id, parent: "coord" })), long }, at);
  const i = wait(["a", "b", "c"], T0 + 3_000);
  expect(titleOf(i)).toBe("Provider cannot be reached");
  expect(radiusOf(i)).toBe("3 agents waiting");
  expect(owesAlert(i)).toBe(false);
  // A session that left the wait went on.
  wait(["a", "b"], T0 + 20_000);
  expect(i.touched.find((t) => t.id === "c")!.state).toBe("went_on");
  // One answered request while others still wait does not end it, and the quiet never does.
  expect(b.clear("provider:p", "it answers again", T0 + 30_000)).toBeUndefined();
  expect(b.quiet(T0 + QUIET_MS * 3)).toEqual([]);
  wait(["a", "b"], T0 + 5 * 60_000, true);
  expect(owesAlert(i)).toBe(true);
  const c = b.unheld("provider:p", "it answers again, after 8 min", T0 + 8 * 60_000)!;
  expect(c.touched.every((t) => t.state === "went_on")).toBe(true);
  expect(radiusOf(c)).toBe("3 agents: all went on");
  expect(owesAlert(c)).toBe(false);
});

test("a failure storm before the wait and the wait are one incident", () => {
  const b = book();
  b.hit(fail(T0, "a", null));
  const i = b.held({ key: "provider:p", label: "Provider", since: T0 + 1_000, message: "ECONNREFUSED", sessions: [{ id: "b", title: "b" }] }, T0 + 4_000);
  expect(i.since).toBe(T0);
  expect(i.failed).toBe(1);
  expect(owesAlert(i)).toBe(true);
});

test("a cause with no sign of its end clears when it went quiet", () => {
  const b = book();
  const stall = (at: number): Hit => ({ key: "stall", cause: "stall", cls: "stall", at, message: "Daemon unresponsive for 3 s" });
  b.hit(stall(T0));
  b.hit(stall(T0 + 10_000));
  const i = b.hit(stall(T0 + 20_000))!;
  expect(radiusOf(i)).toBe("3 stalls");
  expect(owesAlert(i)).toBe(true);
  expect(b.quiet(T0 + 20_000 + QUIET_MS - 1)).toEqual([]);
  expect(b.quiet(T0 + 20_000 + QUIET_MS)[0]!.cleared_how).toBe("nothing more of it for 10 min");
});

test("a stop of the daemon it did not choose is an incident by itself", () => {
  const b = book();
  const i = b.hit({ key: "restarts", cause: "restarts", cls: "killed", at: T0, message: "went down", now: true })!;
  expect(titleOf(i)).toBe("Keel went down by itself");
  b.hit({ key: "restarts", cause: "restarts", cls: "crash", at: T0 + 60_000, message: "ended on a failure", now: true });
  expect(titleOf(i)).toBe("Keel went down by itself 2 times");
  // No turn was running: the row says so, with no empty sentence.
  expect(lineOf(i)).toBe("Keel went down by itself 2 times. No turn was running, so none was cut.");
  expect(bodyOf(i)).toBe("No turn was running, so none was cut.");
});

test("only a stop nobody chose is an incident: a signal (systemd's stop or restart), a stop and a restart are planned", () => {
  expect(wentDownByItself("killed")).toBe(true);
  expect(wentDownByItself("crash")).toBe(true);
  for (const how of ["signal", "stop", "restart", undefined]) expect(wentDownByItself(how)).toBe(false);
});
