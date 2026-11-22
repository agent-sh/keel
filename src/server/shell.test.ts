import { expect, test } from "bun:test";
import { ackShell, attachShell, handShell, shellAttached, shellList, shellShows, tellShells } from "./shell.ts";

const app = (got: string[], name: string, onNotify?: (ack: number) => void) =>
  attachShell({ engine: "webkit", version: name, acks: true }, (e, d: any) => { got.push(`${name} ${e} ${d.alert ?? d.n}`); if (e === "notify") onNotify?.(d.ack); return true; }, () => got.push(`${name} closed`));

// One alert goes to one place: an app that says it showed it, or nobody (the daemon then shows it itself).
test("an alert is the app's only once the app said it showed it", async () => {
  expect(shellAttached()).toBe(false);
  expect(await handShell({ alert: "a" })).toBe(false);

  const got: string[] = [];
  const detachFirst = app(got, "first", (ack) => queueMicrotask(() => ackShell(ack)));
  const detachSecond = app(got, "second", (ack) => queueMicrotask(() => ackShell(ack)));
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

  // The next app in line gets it when the first says nothing.
  app(got, "stopped");
  const detach = app(got, "live", (ack) => queueMicrotask(() => ackShell(ack)));
  expect(await handShell({ alert: "b" }, { wait: 30 })).toBe(true);
  expect(got.slice(2)).toEqual(["stopped notify b", "stopped closed", "live notify b"]);
  expect(shellList().map((s) => s.version)).toEqual(["live"]);
  detach();
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
  attachShell({ engine: "webkit", version: "slow", acks: true }, (_e, d: any) => { ack = d.ack; return true; });
  expect(await handShell({ alert: "a" }, { wait: 20, late: () => late++ })).toBe(false);
  expect(ackShell(ack)).toBe(true);
  expect(late).toBe(1);
  expect(ackShell(ack)).toBe(false);
  expect(ackShell(987654)).toBe(false);
  expect(late).toBe(1);
});

test("a shell whose stream is gone is dropped, and the alert goes to the next or back to the daemon", async () => {
  const got: string[] = [];
  attachShell({ engine: "webkit", version: "1", acks: true }, () => false);
  const detach = app(got, "2", (ack) => queueMicrotask(() => ackShell(ack)));
  expect(await handShell({})).toBe(true);
  expect(shellList().map((s) => s.version)).toEqual(["2"]);
  detach();
  attachShell({ engine: "webkit", version: "3", acks: true }, () => false);
  expect(await handShell({})).toBe(false);
  expect(shellAttached()).toBe(false);
});
