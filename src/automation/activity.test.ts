// The activity list as the owner reads it afterwards: one row a turn, what
// went wrong alone, a time range, a busy session held to a few rows with the
// rest counted, and the text form. And a turn the model declined is never
// filed as finished.
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../core/bus.ts";
import { localDay, zoneLabel } from "../core/clock.ts";
import { Store } from "../core/store.ts";
import * as activity from "./activity.ts";
import * as alerts from "./alerts.ts";
import { setDeps } from "./core.ts";
import * as snooze from "./snooze.ts";

function scratch() {
  const store = new Store(mkdtempSync(join(tmpdir(), "keel-activity-")));
  if (!store.columnExists("sessions", "parent_id")) store.migrate("ALTER TABLE sessions ADD COLUMN parent_id TEXT");
  setDeps({ store, bus: new Bus(), errors: { capture: () => {} } } as any);
  alerts.migrate();
  activity.migrate();
  snooze.migrate();
  alerts.saveSettings({ routes: Object.fromEntries(alerts.KINDS.map((k) => [k, []])) as any });
  const session = (title: string) => store.createSession({ title, model: "m", workspace: "/" }).id;
  // A turn's end as the daemon records it: the turn's own row, then the alert its end raises.
  let n = 0;
  const turn = (s: string, reason: string, reply?: string) => {
    const start = store.append(s, "turn_start", { model: "m" });
    if (reply) store.append(s, "assistant", { blocks: [{ type: "text", text: reply }] });
    if (reason === "error") store.append(s, "error", { message: "HTTP 402: credit balance too low" });
    const title = store.session(s)!.title;
    activity.record("turn", reason, s, `${title}: turn ${{ end_turn: "finished", error: "failed", refusal: "declined by the model" }[reason]}`, undefined, start.id);
    activity.ofTurn(s, start.id, () => alerts.onTurnEnd(s, reason, { subagent: false, loopRun: false, more: false }));
    // Each turn a second after the one before it, the first the oldest.
    store.db.query("UPDATE activity SET ts = ? WHERE turn_event = ?").run(T0 + ++n * 1000, start.id);
    return start.id;
  };
  return { store, session, turn };
}
// Seven in the morning two days ago: in the past, and inside the thirty days the list keeps.
const T0 = (() => { const d = new Date(Date.now() - 2 * 86_400_000); d.setHours(7, 0, 0, 0); return d.getTime(); })();

test("one row a turn, with what its alert said; alerts alone are still listed", () => {
  const { session, turn } = scratch();
  const s = session("Build");
  turn(s, "end_turn", "Checks passed");
  turn(s, "error");
  // Two rows were written a turn (the turn's and its alert's); one is listed.
  expect(activity.list({ kinds: ["alert"] }).items.map((a) => a.sub)).toEqual(["failed", "finished"]);
  const rows = activity.list().items;
  expect(rows.map((a) => [a.kind, a.sub, a.said])).toEqual([
    ["turn", "error", "Failed: Build: HTTP 402: credit balance too low"],
    ["turn", "end_turn", "Build: Checks passed"],
  ]);
  // An alert that no turn's end raised (an approval) keeps its own row.
  alerts.raise("approval", s, "Build", "Bash: rm -rf ./out");
  expect(activity.list().items.map((a) => a.kind).sort()).toEqual(["alert", "turn", "turn"]);
  // Turns filtered out: the alert is the row left of each turn.
  expect(activity.list({ kinds: ["alert"] }).items).toHaveLength(3);
});

test("failures alone, a time range, and a busy session held to a few rows with the rest counted", () => {
  const { session, turn, store } = scratch();
  const busy = session("Many turns"), other = session("Billing A"), quiet = session("Docs");
  turn(quiet, "end_turn", "Docs are done");
  turn(other, "error");
  for (let i = 0; i < 40; i++) turn(busy, "end_turn", `Reply ${i}`);
  // Uncapped, the busy session fills a page of twenty.
  expect(new Set(activity.list({ limit: 20 }).items.map((a) => a.session_id))).toEqual(new Set([busy]));
  const capped = activity.list({ limit: 20, cap: 3 }).items;
  expect(capped.map((a) => [store.session(a.session_id!)!.title, a.more])).toEqual([
    ["Many turns", undefined], ["Many turns", undefined], ["Many turns", 37], ["Billing A", undefined], ["Docs", undefined],
  ]);
  // A session asked for by name is listed whole.
  expect(activity.list({ session_id: busy, cap: 3, limit: 100 }).items).toHaveLength(40);
  expect(activity.list({ failures: true }).items.map((a) => a.text)).toEqual(["Billing A: turn failed"]);
  // A range: from the fourth turn (T0 + 4 s) to before the seventh.
  expect(activity.list({ since: T0 + 4000, until: T0 + 7000, limit: 100 }).items.map((a) => a.said)).toEqual(["Many turns: Reply 3", "Many turns: Reply 2", "Many turns: Reply 1"]);
  // Paged with the cap: the next page starts after the last row shown and repeats nothing.
  const first = activity.list({ limit: 4, cap: 3 });
  const end = first.items.at(-1)!;
  const next = activity.list({ limit: 4, cap: 3, before: `${end.ts}:${end.id}` });
  expect([first.has_more, next.items.map((a) => store.session(a.session_id!)!.title), next.has_more]).toEqual([true, ["Docs"], false]);
});

test("the text form: a line a row in local time with the offset said once, and how to read the rest", () => {
  const { session, turn, store } = scratch();
  const busy = session("Many turns");
  for (let i = 0; i < 5; i++) turn(busy, "end_turn", `Reply ${i}`);
  activity.record("awake", "hold", null, "Kept the machine awake for 2 min (1 turn running)");
  store.db.query("UPDATE activity SET ts = ? WHERE kind = 'awake'").run(T0);
  const page = activity.list({ cap: 2 });
  const text = activity.activityText(page.items, { titleOf: (id) => store.session(id)?.title, now: T0, what: "failures only" }).split("\n");
  const short = busy.slice(-12);
  expect(text).toEqual([
    `Activity, failures only, newest first. Times are local (${zoneLabel(T0)}).`,
    localDay(T0),
    `  07:00:05  turn     Many turns: turn finished (Reply 4)  [session=${short}]`,
    `  07:00:04  turn     Many turns: turn finished (Reply 3)  [session=${short}]`,
    `            3 more in "Many turns": keel activity --session ${short}`,
    "  07:00:00  awake    Kept the machine awake for 2 min (1 turn running)",
  ]);
  expect(activity.activityText([], { titleOf: () => undefined, now: T0 })).toEndWith("Nothing happened.");
});

test("a turn the model declined is not filed as finished", () => {
  const { session, turn } = scratch();
  const s = session("Refuses");
  turn(s, "refusal", "I will not");
  const a = alerts.list({ limit: 1 })[0]!;
  expect([a.kind, a.title, a.body]).toEqual(["declined", "Declined: Refuses", "I will not"]);
  // With nothing said, the alert says what happened.
  turn(s, "refusal");
  expect(alerts.list({ limit: 1 })[0]!.body).toBe("The model declined the turn.");
  expect(alerts.list({ limit: 10 }).some((x) => x.kind === "finished")).toBe(false);
  // It is among what went wrong, one row a turn.
  expect(activity.list({ failures: true }).items.map((x) => [x.kind, x.sub, x.said])).toEqual([
    ["turn", "refusal", "Declined: Refuses: The model declined the turn."], ["turn", "refusal", "Declined: Refuses: I will not"],
  ]);
});

// A wait on the owner has one age: the alert of a decision raised again (a restart puts its card back) keeps the time it was first asked.
test("an approval raised again keeps the time it was first asked", () => {
  const { session, store } = scratch();
  const s = session("Needs approval");
  const first = alerts.raise("approval", s, "Approval: Needs approval", "Bash: touch x", { approval_id: "ap-1", open_session: s })!;
  store.db.query("UPDATE alerts SET ts = ? WHERE id = ?").run(T0, first.id);
  // The daemon restarts and puts the card back; then once more, after the owner read the row.
  const again = alerts.raise("approval", s, "Approval: Needs approval", "Bash: touch x", { approval_id: "ap-1", open_session: s })!;
  expect([again.id === first.id, again.ts]).toEqual([false, T0]);
  alerts.readWhere("approval_id", "ap-1");
  expect(alerts.raise("approval", s, "Approval: Needs approval", "Bash: touch x", { approval_id: "ap-1", open_session: s })!.ts).toBe(T0);
  // Another decision of the same session is asked now.
  expect(alerts.raise("approval", s, "Approval: Needs approval", "Bash: touch y", { approval_id: "ap-2", open_session: s })!.ts).toBeGreaterThan(T0);
});
