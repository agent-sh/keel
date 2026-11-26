// The helper's records are recalled for what its note shows: the owner's prompt and the digest lines it
// carries, never the events past the lines the digest shows.
import { afterAll, expect, test } from "bun:test";
import { Bus } from "../core/bus.ts";
import { Store } from "../core/store.ts";
import { allHooks } from "../engine/hooks.ts";
import { tempTree } from "../../test/env.ts";
import { DIGEST_LINES, Helper } from "./helper.ts";
import type { MailSource } from "./mail.ts";

const noMail = { id: "none", label: "No mail", available: () => false, account: () => undefined, can: { modify: false, send: false, calendar: false } } as unknown as MailSource;
const hooksAtStart = allHooks().length;
let helper: Helper | undefined;
afterAll(() => { helper?.stop(); allHooks().length = hooksAtStart; });

test("a record is recalled for a digest event the note shows, not for one past what it shows", async () => {
  const store = new Store(tempTree("keel-helper-digest-recall-"));
  helper = new Helper({ store, bus: new Bus(), providers: { defaultModel: async () => "scripted:stand-in" }, workspace: "/", errors: { capture() {}, onCapture: () => () => {} } } as any, noMail);
  helper.configure({ mail_every_min: 0 });
  await helper.setOn(true);
  helper.records.put([{ key: "person.zephyrine", value: "Zephyrine runs the accounts", aliases: ["zephyrine"] }], "helper");
  const note = (prompt: string) => (helper as any).note(helper!.session(), [], prompt) as { recalled: { key: string }[] } | null;
  const fill = (n: number) => { for (let i = 0; i < n; i++) helper!.record("finished", null, `Build ${i} finished`, "", "feed"); };

  // The name is in the oldest of more events than the digest shows: it is not shown, so nothing is recalled for it.
  helper.record("mail", null, "Mail from zephyrine", "", "feed");
  fill(DIGEST_LINES);
  expect(note("what happened?")?.recalled.map((r) => r.key) ?? []).toEqual([]);
  // The owner naming it still recalls it.
  expect(note("ask zephyrine")?.recalled.map((r) => r.key)).toEqual(["person.zephyrine"]);
  // In a shown line it is recalled.
  helper.record("mail", null, "Mail from zephyrine again", "", "feed");
  expect(note("what happened?")?.recalled.map((r) => r.key)).toEqual(["person.zephyrine"]);
});
