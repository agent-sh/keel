import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Bus } from "../core/bus.ts";
import { Store } from "../core/store.ts";
import { allHooks } from "../engine/hooks.ts";
import { tempTree } from "../../test/env.ts";
import { Helper } from "./helper.ts";
import type { MailSource } from "./mail.ts";
import { isNews } from "./told.ts";

const noMail = { id: "none", label: "No mail", available: () => false, account: () => undefined, can: { modify: false, send: false, calendar: false } } as unknown as MailSource;
const hooksAtStart = allHooks().length;
let helper: Helper | undefined;
afterAll(() => { helper?.stop(); allHooks().length = hooksAtStart; });

// An alert frame as the inbox puts it on the bus.
const frame = (bus: Bus, a: Record<string, unknown>) => bus.emit({ t: "feature", name: "automation", data: { kind: "alert", data: a } } as any);
const card = (over: Record<string, unknown> = {}) => ({
  id: crypto.randomUUID(), ts: 1, kind: "approval", session_id: "s-1", read: false, title: "Approval: Build", body: "Bash: make", channels: ["desktop"],
  data: { approval_id: "ap-1", open_session: "s-1" }, ...over,
});

test("an open approval card is told to the helper once: its delivery, a restart and a read are the same news, a changed card is not", async () => {
  const store = new Store(tempTree("keel-helper-told-"));
  const bus = new Bus();
  helper = new Helper({ store, bus, providers: { defaultModel: async () => "scripted:stand-in" }, workspace: "/", errors: { capture() {}, onCapture: () => () => {} } } as any, noMail);
  helper.configure({ mail_every_min: 0 });
  await helper.setOn(true);
  helper.install();
  const told = () => helper!.events(50).filter((e) => e.kind === "approval").length;
  const first = card();
  // The raise, then the desktop's word that it was shown: two frames of one row.
  frame(bus, first);
  frame(bus, { ...first, delivery: { desktop: { state: "sent" } } });
  expect(told()).toBe(1);
  // A restart puts the card back: a new row of the same wait, the same words.
  frame(bus, card());
  frame(bus, { ...first, read: true });
  expect(told()).toBe(1);
  // Another card is news, and so is the same card when its words changed.
  frame(bus, card({ data: { approval_id: "ap-2", open_session: "s-1" } }));
  expect(told()).toBe(2);
  frame(bus, card({ body: "Bash: make install" }));
  expect(told()).toBe(3);
});

test("a row that is not a decision is told once by its id, and the table forgets after thirty days", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE helper_told (key TEXT PRIMARY KEY, fp TEXT NOT NULL, ts INTEGER NOT NULL);");
  const a = { id: "a-1", title: "Failed: Docs", body: "the provider refused", session_id: "s-2", data: {} };
  expect([isNews(db, a, 1000), isNews(db, { ...a }, 2000)]).toEqual([true, false]);
  expect(isNews(db, { ...a, id: "a-2" }, 3000)).toBe(true);
  expect(isNews(db, { ...a, id: "a-3" }, 3000 + 31 * 86400_000)).toBe(true);
  expect(db.query("SELECT count(*) AS n FROM helper_told").get()).toEqual({ n: 1 });
});
