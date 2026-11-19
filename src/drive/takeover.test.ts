import { expect, test } from "bun:test";
import { inFlight } from "./drive.ts";
import { scheduledJobs } from "./takeover.ts";

const call = (id: string, name: string, input: object) => JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } });
const answer = (id: string, at: number, result: object) =>
  JSON.stringify({ type: "user", timestamp: new Date(at).toISOString(), toolUseResult: result, message: { content: [{ type: "tool_result", tool_use_id: id, content: "Scheduled" }] } });

test("the jobs a transcript leaves set are the ones made and not deleted or expired", () => {
  const now = 1_800_000_000_000;
  const day = 24 * 3600 * 1000;
  const lines = [
    call("c1", "CronCreate", { cron: "*/15 * * * *", prompt: "Check the run", recurring: true }),
    answer("c1", now - day, { id: "a1", recurring: true }),
    call("c2", "CronCreate", { cron: "0 9 * * *", prompt: "Old one", recurring: true }),
    answer("c2", now - 8 * day, { id: "a2", recurring: true }),
    call("c3", "CronCreate", { cron: "5 3 1 1 *", prompt: "Once, later", recurring: false }),
    answer("c3", now - day, { id: "a3", recurring: false, durable: true, nextFireAt: now + day }),
    call("c4", "CronCreate", { cron: "5 3 1 1 *", prompt: "Once, past", recurring: false }),
    answer("c4", now - day, { id: "a4", recurring: false, nextFireAt: now - 1 }),
    call("c5", "CronCreate", { cron: "1 * * * *", prompt: "Deleted", recurring: true }),
    answer("c5", now - day, { id: "a5", recurring: true }),
    call("d5", "CronDelete", { id: "a5" }),
    answer("d5", now - day, { id: "a5" }),
  ];
  const jobs = scheduledJobs(lines.join("\n"), now);
  expect(jobs.map((j) => j.id)).toEqual(["a1", "a3"]);
  expect(jobs[1]).toMatchObject({ durable: true, recurring: false });
});

test("work in flight is a turn, subagents or tasks, and a wake alone is not", () => {
  expect(inFlight({ state: "idle" })).toBeNull();
  expect(inFlight({ state: "working", hold: "wakes 14:30", tasks: 0 })).toBeNull();
  expect(inFlight({ state: "working", hold: "loop every 15m" })).toBeNull();
  expect(inFlight({ state: "working", hold: "background shell" })).toBe("background shell");
  expect(inFlight({ state: "working" })).toBe("a turn running");
  expect(inFlight({ state: "idle", tasks: 2 })).toBe("2 background tasks (subagents or shell jobs)");
});
