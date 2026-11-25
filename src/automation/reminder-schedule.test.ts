import { expect, test } from "bun:test";
import { dueCount, offsetOf, reachLine, reminderWords, step, waited } from "./reminder-schedule.ts";

const MIN = 60_000, H = 60 * MIN;

test("the gaps grow: 15 min, 1 h, 4 h, then every 4 h", () => {
  expect([1, 2, 3, 4, 5].map((n) => offsetOf(n) / MIN)).toEqual([15, 60, 240, 480, 720]);
  expect([0, 14 * MIN, 15 * MIN, 59 * MIN, H, 3 * H, 4 * H, 7 * H, 8 * H, 12 * H].map(dueCount)).toEqual([0, 0, 1, 1, 2, 2, 3, 3, 4, 5]);
});

test("a look tells once for the gaps it passed, and a later look tells the next", () => {
  const asked = 1_000_000, away = asked - 10 * MIN;
  let s = step(asked, away, undefined, asked + 14 * MIN);
  expect(s).toMatchObject({ remind: false, sent: 0, nextAt: asked + 15 * MIN });
  s = step(asked, away, s, asked + 16 * MIN);
  expect(s).toMatchObject({ remind: true, sent: 1, nextAt: asked + H });
  // Looked at again at once, and a restart (the kept step is all that is known): nothing more.
  expect(step(asked, away, s, asked + 17 * MIN).remind).toBe(false);
  // A look that comes after 5 h (a daemon that was down): one reminder, not one for each gap.
  s = step(asked, away, s, asked + 5 * H);
  expect(s).toMatchObject({ remind: true, sent: 3, nextAt: asked + 8 * H });
  expect(step(asked, away, s, asked + 8 * H).sent).toBe(4);
});

test("the gaps count from the start of the absence when that is after the card", () => {
  const asked = 0, away = 3 * H;
  expect(step(asked, away, undefined, 3 * H + 14 * MIN).remind).toBe(false);
  expect(step(asked, away, undefined, 3 * H + 15 * MIN)).toMatchObject({ remind: true, sent: 1 });
});

test("the same absence read a few milliseconds apart keeps its count; a new absence starts again", () => {
  const asked = 0, away = 100 * MIN;
  const s = step(asked, away, undefined, away + 20 * MIN);
  expect(s.sent).toBe(1);
  expect(step(asked, away + 40, s, away + 21 * MIN)).toMatchObject({ remind: false, sent: 1, anchor: s.anchor });
  // The owner came back and left again an hour later: this absence counts from its own start.
  const next = step(asked, away + 2 * H, s, away + 2 * H + 16 * MIN);
  expect(next).toMatchObject({ remind: true, sent: 1, anchor: away + 2 * H });
});

test("the words say how long the card has waited, and how many more wait", () => {
  expect(waited(20 * MIN)).toBe("20 min");
  expect(waited(4 * H + 43 * MIN)).toBe("4 h 43 min");
  expect(waited(7 * H)).toBe("7 h");
  expect(reminderWords("Allow Bash", "git push", 0, 0, 7 * H)).toEqual({ title: "Still waiting: Allow Bash", body: "Waiting 7 h.\ngit push" });
  expect(reminderWords("Allow Bash", "git push", 0, 2, 20 * MIN).body).toBe("Waiting 20 min. 2 more cards wait in this session.\ngit push");
});

test("the line that says where reminders reach", () => {
  expect(reachLine({ paired: false, available: false })).toBe("No phone paired: reminders reach this desktop only");
  expect(reachLine({ paired: true, available: false })).toBe("Phone push is not set up: reminders reach this desktop only");
  expect(reachLine({ paired: true, available: true })).toBeNull();
});
