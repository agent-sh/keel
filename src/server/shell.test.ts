import { expect, test } from "bun:test";
import { ackShell, attachShell, handShell, shellAttached, shellList, shellShows, shellTakes, tellShells } from "./shell.ts";

// An app whose stream's word is its name: it acknowledges with that word.
const app = (got: string[], name: string, shown = false) =>
  attachShell({ engine: "webkit", version: name, acks: true }, (e, d: any) => { got.push(`${name} ${e} ${d.alert ?? d.n}`); if (e === "notify" && shown) queueMicrotask(() => ackShell(d.ack, name)); return true; }, () => got.push(`${name} closed`), name);

// One alert goes to one place: an app that says it showed it, or nobody (the daemon then shows it itself).
test("an alert is the app's only once the app said it showed it", async () => {
  expect(shellAttached()).toBe(false);
  expect(await handShell({ alert: "a" })).toBe(false);

  const got: string[] = [];
  const detachFirst = app(got, "first", true);
  const detachSecond = app(got, "second", true);
  expect(shellList().map((s) => s.version)).toEqual(["first", "second"]);

  // A notification is shown once: by the first app alone.
  expect(await handShell({ alert: "a" })).toBe(true);
  expect(got).toEqual(["first notify a"]);
  // What every shell shows (the count on its mark) goes to each.
  tellShells("needs", { n: 2 });
  expect(got.slice(1)).toEqual(["first needs 2", "second needs 2"]);

  detachFirst();
  expect(await handShell({ alert: "b" })).toBe(true);
  expect(got.at(-1)).toBe("second notify b");
  detachSecond();
  expect(shellAttached()).toBe(false);
});

// The review's cases. An app stopped by a signal, or with no notification service on its bus,
// took the alert off the stream and never showed it; the daemon recorded it as sent.
test("an app that does not say it showed the alert loses it, and is detached", async () => {
  const got: string[] = [];
  app(got, "stopped");
  expect(await handShell({ alert: "a" }, { wait: 30 })).toBe(false);
  expect(got).toEqual(["stopped notify a", "stopped closed"]);
  expect(shellAttached()).toBe(false);

  // The next app in line does not get that alert (the daemon shows it); it takes the alerts from the next one on, and is told.
  app(got, "stopped");
  const detach = app(got, "live", true);
  expect(await handShell({ alert: "b" }, { wait: 30 })).toBe(false);
  expect(got.slice(2)).toEqual(["stopped notify b", "stopped closed", "live takes undefined"]);
  expect(shellList().map((s) => [s.version, s.takes])).toEqual([["live", true]]);
  expect(await handShell({ alert: "c" }, { wait: 30 })).toBe(true);
  expect(got.at(-1)).toBe("live notify c");
  detach();
});

// The review's case: a second program of the same account attaches as a shell that acknowledges
// and answers with its own word. One shell takes the alerts, the one attached first; the other
// is handed none, and knows it.
test("one shell takes the alerts, and another is told it does not", async () => {
  const got: string[] = [];
  const detachApp = app(got, "the-app", true);
  const detachOther = app(got, "another", true);
  expect([shellTakes("the-app"), shellTakes("another"), shellTakes("nobody")]).toEqual([true, false, false]);
  expect(shellList().map((s) => [s.version, s.takes])).toEqual([["the-app", true], ["another", false]]);
  for (const alert of ["a", "b", "c"]) expect(await handShell({ alert }, { wait: 200 })).toBe(true);
  expect(got).toEqual(["the-app notify a", "the-app notify b", "the-app notify c"]);
  // The first leaves: the other is told the alerts are its own now, and gets the next.
  detachApp();
  expect(got.at(-1)).toBe("another takes undefined");
  expect(shellTakes("another")).toBe(true);
  expect(await handShell({ alert: "d" }, { wait: 200 })).toBe(true);
  expect(got.at(-1)).toBe("another notify d");
  detachOther();
  // A reader that does not acknowledge never takes them, however long it has been attached.
  const detachReader = attachShell({ engine: "", version: "reader", acks: false }, () => true, () => {}, "reader");
  const detachLate = app(got, "late", true);
  expect([shellTakes("reader"), shellTakes("late")]).toEqual([false, true]);
  detachReader();
  detachLate();
});

// A reader of the stream that is not the app (it never said it acknowledges) holds no alert at all.
test("a reader of the stream that is not the app is never handed an alert", async () => {
  const got: string[] = [];
  const detach = attachShell({ engine: "", version: "reader", acks: false }, (e) => { got.push(e); return true; });
  expect(shellAttached()).toBe(true);
  expect(shellShows()).toBe(false);
  const started = Date.now();
  expect(await handShell({ alert: "a" }, { wait: 2000 })).toBe(false);
  expect(Date.now() - started).toBeLessThan(500);
  expect(got).toEqual([]);
  tellShells("needs", { n: 1 });
  expect(got).toEqual(["needs"]);
  detach();
});

// The app showed it after all, a moment too late: the daemon's own copy is taken down.
test("a word that comes late is told, once", async () => {
  let ack = 0;
  let late = 0;
  attachShell({ engine: "webkit", version: "slow", acks: true }, (_e, d: any) => { ack = d.ack; return true; }, () => {}, "slow");
  expect(await handShell({ alert: "a" }, { wait: 20, late: () => late++ })).toBe(false);
  expect(ackShell(ack, "slow")).toBe(true);
  expect(late).toBe(1);
  expect(ackShell(ack, "slow")).toBe(false);
  expect(ackShell(987654, "slow")).toBe(false);
  expect(late).toBe(1);
});

// The review's case: the numbers are one sequence for every stream, so a local program that read
// its own stream could post the number of an alert handed to the app, and the alert was recorded
// as shown without being shown.
test("an alert is acknowledged only from the stream it was handed to", async () => {
  let ack = 0;
  const detachApp = attachShell({ engine: "webkit", version: "app", acks: true }, (_e, d: any) => { ack = d.ack; return true; }, () => {}, "the-apps-word");
  const detachOther = attachShell({ engine: "", version: "other", acks: true }, () => true, () => {}, "another-word");
  const handed = handShell({ alert: "a" }, { wait: 200 });
  await Promise.resolve();
  // The other stream's reader guesses the number (it is the next of a sequence it can see).
  expect(ackShell(ack, "another-word")).toBe(false);
  expect(ackShell(ack, "")).toBe(false);
  // Only the app's own word counts.
  expect(ackShell(ack, "the-apps-word")).toBe(true);
  expect(await handed).toBe(true);
  detachApp();
  detachOther();
});

test("a shell whose stream is gone is dropped, and the alert goes to the next or back to the daemon", async () => {
  const got: string[] = [];
  attachShell({ engine: "webkit", version: "1", acks: true }, () => false);
  const detach = app(got, "2", true);
  expect(await handShell({})).toBe(true);
  expect(shellList().map((s) => s.version)).toEqual(["2"]);
  detach();
  attachShell({ engine: "webkit", version: "3", acks: true }, () => false);
  expect(await handShell({})).toBe(false);
  expect(shellAttached()).toBe(false);
});
