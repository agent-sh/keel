import { expect, test } from "bun:test";
import { alertPush } from "../../server/routes/mobile.ts";
import { PhoneShown } from "./shown.ts";

// Two approvals of one session on the phone: the one answered elsewhere comes down by its aid, and the
// push names no session (an app from before would take down the other too); the other stays until the session is read.
test("an answered approval's notification is taken back alone; the session's come down when it is read", () => {
  const shown = new PhoneShown();
  const approval = (id: string) => alertPush({ id: `al-${id}`, kind: "approval", session_id: "s-1", title: "Approval: S", body: "Bash: ls", data: { approval_id: id, open_session: "s-1" } } as any);
  shown.pushed(approval("apA"));
  shown.pushed(approval("apB"));
  expect(shown.takeBack("apA")).toEqual({ kind: "withdraw", session_id: null, high: false, data: { aid: "apA" } });
  expect(shown.takeBack("apA")).toBeNull(); // taken back once
  expect(shown.takeBack("never-pushed")).toBeNull();
  expect(shown.clear("s-1")).toEqual({ kind: "withdraw", session_id: "s-1", high: false, data: {} });
  expect(shown.takeBack("apB")).toBeNull(); // the session's withdraw took it down
  expect(shown.clear("s-1")).toBeNull();
});
