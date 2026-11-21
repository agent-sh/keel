import { expect, test } from "bun:test";
import { attachShell, shellAttached, shellList, tellShell, tellShells } from "./shell.ts";

// One alert goes to one place: a shell that takes it, or nobody (the daemon then shows it itself).
test("an alert is handed to one attached shell, and to none when none takes it", () => {
  expect(shellAttached()).toBe(false);
  expect(tellShell("notify", { alert: "a" })).toBe(false);

  const got: string[] = [];
  const detachFirst = attachShell({ engine: "webkit", version: "1" }, (e, d: any) => { got.push(`first ${e} ${d.alert ?? d.n}`); return true; });
  const detachSecond = attachShell({ engine: "webkit", version: "1" }, (e, d: any) => { got.push(`second ${e} ${d.alert ?? d.n}`); return true; });
  expect(shellList().map((s) => s.engine)).toEqual(["webkit", "webkit"]);

  // A notification is shown once: by the first shell alone.
  expect(tellShell("notify", { alert: "a" })).toBe(true);
  expect(got).toEqual(["first notify a"]);
  // What every shell shows (the count on its mark) goes to each.
  tellShells("needs", { n: 2 });
  expect(got.slice(1)).toEqual(["first needs 2", "second needs 2"]);

  detachFirst();
  expect(tellShell("notify", { alert: "b" })).toBe(true);
  expect(got.at(-1)).toBe("second notify b");
  detachSecond();
  expect(shellAttached()).toBe(false);
});

test("a shell whose stream is gone is dropped, and the alert goes to the next or back to the daemon", () => {
  const got: string[] = [];
  attachShell({ engine: "webkit", version: "1" }, () => false);
  const detach = attachShell({ engine: "webkit", version: "2" }, (e) => { got.push(e); return true; });
  expect(tellShell("notify", {})).toBe(true);
  expect(got).toEqual(["notify"]);
  expect(shellList().map((s) => s.version)).toEqual(["2"]);
  detach();
  attachShell({ engine: "webkit", version: "3" }, () => false);
  expect(tellShell("notify", {})).toBe(false);
  expect(shellAttached()).toBe(false);
});
