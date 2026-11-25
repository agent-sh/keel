import { expect, test } from "bun:test";
import { plainTitle, trayFrame } from "./shell-list.ts";

const titles: Record<string, string> = { a: "Alpha", b: "Beta", c: "Gamma", d: "Delta", e: "Eps", f: "Zeta", g: "Eta", h: "Theta" };
const at = (id: string) => id.charCodeAt(0);

test("the list is the sessions that need the owner, then the unread, then the working, five at most", () => {
  const f = trayFrame(new Map([["a", 1], ["b", 2]]), new Set(["c", "d", "a"]), { b: 1, e: 2, d: 1, f: 1, g: 1, zz: 4 }, (id) => titles[id], at);
  // b and a need (newest first: b), then the unread that do not need (g, f, e by recency), the working d is unread so it is listed there.
  expect(f.list.map((l) => `${l.id}:${l.state}`)).toEqual(["b:need", "a:need", "g:unread", "f:unread", "e:unread"]);
  expect(f.list.map((l) => l.word)).toEqual(["Needs you", "Needs you", "Unread", "Unread", "Unread"]);
  // The count is what waits, listed or not; the unread count is every unread alert (a session this machine does not hold included).
  expect(f.n).toBe(3);
  expect(f.unread).toBe(10);
  expect(trayFrame(new Map(), new Set(["c"]), {}, (id) => titles[id], at).list).toEqual([{ id: "c", title: "Gamma", state: "work", word: "Working" }]);
});

test("none that waits, is unread or works gives no list", () => {
  expect(trayFrame(new Map(), new Set(), {}, (id) => titles[id], at)).toEqual({ n: 0, unread: 0, list: [], reach: null });
});

test("a title is one plain line", () => {
  expect(plainTitle("a\nb\u202ec\u0007 d")).toBe("a bc d");
  expect(plainTitle("<b>x</b>")).toBe("<b>x</b>");
  expect(plainTitle("  ")).toBe("Untitled session");
  expect([...plainTitle("x".repeat(200))].length).toBe(80);
});

test("the frame carries where reminders reach, for the tray's line", () => {
  expect(trayFrame(new Map([["a", 1]]), new Set(), {}, () => "A", () => 0, "No phone paired: reminders reach this desktop only").reach).toBe("No phone paired: reminders reach this desktop only");
});
