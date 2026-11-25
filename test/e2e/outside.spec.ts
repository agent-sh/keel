import { expect, test } from "./isolate.ts";
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { HAIKU, ask, shoot } from "./shots.ts";

// Feature: sessions the owner runs in another harness, in Keel's list while
// they run. A Claude Code transcript that grows while the daemon watches gets
// a session in the list and on the home screen, read-only, in the state its
// own records say: working while it writes, waiting when it asks, done when
// its turn ended; its usage, the files its calls changed and its failed call
// beside the transcript, which grows in the view while the page shows it. One
// press copies it into Keel, where the copy goes on. Keel writes nothing
// to the other harness's folder. Run the daemon with KEEL_IMPORT_CLAUDE_DIR
// at a scratch store: this test writes its fixture there.
test("a live Claude Code session shows in the list read-only and goes on in Keel", async ({ page, request }) => {
  // The store the daemon reads, as its import list names it.
  const listed = await (await request.get("/api/import/sessions?limit=1")).json();
  const root = listed.harnesses?.find((h: any) => h.harness === "claude")?.store as string | undefined;
  test.skip(!root || !root.includes("keel-work"), "needs a scratch Claude Code store (KEEL_IMPORT_CLAUDE_DIR)");
  const watches = async () => (await (await request.get("/api/outside")).json()).watches as number;
  const tag = String(Date.now());
  const id = `0e2e0000-0000-4000-8000-${tag.slice(-12).padStart(12, "0")}`;
  const cwd = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `outside-${tag}`);
  mkdirSync(cwd, { recursive: true });
  const dir = join(root!, `-e2e-outside-${tag}`);
  const path = join(dir, `${id}.jsonl`);
  const made: string[] = [];
  const written: string[] = [];
  let parent: string | null = null;
  let n = 0;
  const write = (r: object) => {
    const uuid = `${id}-${n++}`;
    const line = JSON.stringify({ cwd, sessionId: id, version: "2.1.300", isSidechain: false, userType: "external", entrypoint: "cli", timestamp: new Date().toISOString(), uuid, parentUuid: parent, ...r });
    parent = uuid;
    written.push(line);
    appendFileSync(path, line + "\n");
  };
  const reply = (mid: string, content: object[], stop: string | null = null) =>
    write({ type: "assistant", message: { id: mid, role: "assistant", model: "claude-opus-4-5", content, stop_reason: stop, usage: { input_tokens: 1200, cache_read_input_tokens: 40_000, output_tokens: 300 } } });
  const sessionOf = async () => ((await (await request.get("/api/sessions")).json()).sessions as any[]).find((s) => s.outside?.source_id === id);
  try {
    // The project folder first: its watch is the daemon's signal that it reads the folder.
    const before = await watches();
    mkdirSync(dir, { recursive: true });
    await expect.poll(watches, { timeout: 10_000 }).toBeGreaterThan(before);
    await page.goto("/");

    // It starts: a prompt, then a call that runs.
    write({ type: "user", message: { role: "user", content: `Rename the config loader ${tag}` } });
    reply("m1", [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "make test" } }]);
    await expect.poll(async () => (await sessionOf())?.outside?.state, { timeout: 15_000 }).toBe("working");
    const sid = (await sessionOf()).id as string;
    made.push(sid);
    const row = page.locator(`[data-testid="session-row"][data-session="${sid}"]`);
    await expect(row).toBeVisible();
    await expect(row.getByTestId("row-outside")).toHaveText("Claude Code");
    await expect(row).toHaveAttribute("data-watch", "work");

    // Opened: its transcript in Keel's view, its bar in the composer's place.
    await row.click();
    const bar = page.getByTestId("outside-bar");
    await expect(bar).toBeVisible();
    await expect(page.getByTestId("outside-state")).toContainText("Working in Claude Code");
    await expect(page.getByText(`Rename the config loader ${tag}`).first()).toBeVisible();
    await expect(page.getByTestId("composer")).toHaveCount(0);
    // Nothing is sent to it.
    const sent = await request.post(`/api/sessions/${sid}/messages`, { data: { text: "hello" } });
    expect(sent.status()).toBe(409);
    // Nor is anything run in its name, cloned from it or switched on it: it goes on in Keel as a copy.
    expect((await request.post(`/api/sessions/${sid}/terminal/run`, { data: { command: "true" } })).status()).toBe(409);
    expect((await request.post(`/api/sessions/${sid}/clone`, { data: {} })).status()).toBe(409);
    expect((await request.patch(`/api/sessions/${sid}`, { data: { model: "scripted:stand-in" } })).status()).toBe(409);
    // Every act in it is refused by one guard, past copying, archiving and deleting: no summary, review or export into a harness's folder.
    for (const [method, path] of [["post", "recap"], ["post", "compact"], ["post", "summarize"], ["post", "side"], ["delete", "side"], ["post", "review"], ["post", "clear"], ["post", "export-to"], ["post", "handoff"]] as const) {
      const r = await request[method](`/api/sessions/${sid}/${path}`, { data: { harness: "claude", machine_id: "local" } });
      expect(r.status(), `${method} ${path}`).toBe(409);
    }

    // The call fails, it edits a file, then asks the owner: it waits.
    write({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "make: *** [test] Error 2", is_error: true }] } });
    reply("m2", [{ type: "tool_use", id: "t2", name: "Edit", input: { file_path: join(cwd, "src/config.ts"), old_string: "load", new_string: "readConfig" } }]);
    write({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: "The file was updated." }] } });
    reply("m3", [{ type: "tool_use", id: "t3", name: "AskUserQuestion", input: { questions: [{ question: "Keep the old name as an alias?" }] } }]);
    await expect(page.getByTestId("outside-state")).toContainText("Waits in Claude Code for your answer to a question");
    await expect(row).toHaveAttribute("data-watch", "need");
    await expect(page.getByTestId("outside-failures")).toHaveText("1 failed call");
    await expect(page.getByTestId("outside-spent")).toContainText("tokens");
    const errors = await (await request.get(`/api/errors?session=${sid}`)).json();
    expect(JSON.stringify(errors)).toContain("Error 2");
    await expect(page.getByText("Keep the old name as an alias?").first()).toBeVisible();
    // Its question is asked there: a record here, never a card Keel could answer.
    await expect(page.getByTestId("question-elsewhere")).toHaveText("waits in Claude Code");
    await expect(page.getByTestId("question-asked")).toHaveCount(0);
    await expect(page.getByTestId("question-submit")).toHaveCount(0);
    await shoot(page, "outside-waiting");
    // On a phone the button stands on its own line, under the sentence.
    await page.setViewportSize({ width: 390, height: 844 });
    const said = (await page.getByTestId("outside-state").boundingBox())!;
    const press = (await page.getByTestId("outside-copy").boundingBox())!;
    expect(press.y).toBeGreaterThanOrEqual(said.y + said.height);
    await shoot(page, "outside-phone");
    await page.setViewportSize({ width: 1920, height: 1040 });
    // On the home screen it is among what needs the owner, with what it waits for.
    await page.goto("/");
    const home = page.locator(`[data-testid="home-session"][data-session="${sid}"]`);
    await expect(home).toHaveAttribute("data-watch", "need");
    await expect(home).toContainText("Waits in Claude Code");
    await shoot(page, "outside-home");
    await page.goto(`/s/${sid}`);
    await expect(page.getByTestId("outside-bar")).toBeVisible();

    // Answered there; it replies and its turn ends: done, and the reply is in the view the page shows.
    write({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t3", content: "Yes, keep it." }] } });
    reply("m4", [{ type: "text", text: `Renamed to readConfig ${tag}, with the old name kept.` }], "end_turn");
    write({ type: "system", subtype: "turn_duration", durationMs: 4000 });
    await expect(page.getByTestId("outside-state")).toContainText("Done in Claude Code");
    await expect(page.getByText(`Renamed to readConfig ${tag}, with the old name kept.`).first()).toBeVisible();
    await expect(row).toHaveAttribute("data-watch", "done");
    await page.getByTestId("outside-files-toggle").click();
    await expect(page.getByTestId("outside-files")).toContainText("src/config.ts");
    await shoot(page, "outside-done");

    // Marked unread, its alert holds nothing of its words: the phone and other machines are told alerts.
    expect((await request.post(`/api/sessions/${sid}/unread`)).ok()).toBe(true);
    const alerts = ((await (await request.get("/api/alerts")).json()).alerts as any[]).filter((a) => a.session_id === sid);
    expect(alerts.map((a) => [a.title, a.body])).toEqual([["Claude Code session", "Marked unread."]]);
    expect((await request.put(`/api/sessions/${sid}/snooze`, { data: { until_ms: Date.now() + 3_600_000 } })).ok()).toBe(true);

    // For a command a Keel session runs it does not exist: not in the list, nor its alert or its snooze, and every
    // read of it is answered as a read of a session that does not exist is, word for word but the id.
    const ws = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `outside-probe-${createHash("sha256").update(tag).digest("hex").slice(0, 8)}`);
    mkdirSync(ws, { recursive: true });
    const { session: keel } = await (await request.post("/api/sessions", { data: { workspace: ws, model: HAIKU } })).json();
    made.push(keel.id);
    const api = `http://127.0.0.1:${new URL(page.url()).port}`;
    const none = randomUUID();
    const lists = ["/api/sessions", "/api/automation", "/api/alerts", "/api/snooze"];
    const named = ["/api/sessions/ID", "/api/sessions/ID/events", "/api/sessions/ID/timeline", "/api/sessions/ID/hours", "/api/sessions/ID/agents", "/api/sessions/ID/secrets", "/api/errors?session=ID", "/api/resources?session_id=ID", "/api/overview?of=ID"];
    const line = (label: string, r: string) => `echo "${label} $(curl -s -m 5 --noproxy '*' -o b.out -w '%{http_code}' '${api}${r}') $(head -c 100000 b.out | tr '\\n' ' ')"`;
    const probe = [...lists.map((r) => line(r, r)), ...named.flatMap((r, i) => [line(`A${i}`, r.replace("ID", sid)), line(`B${i}`, r.replace("ID", none))])];
    writeFileSync(join(ws, "probe.sh"), probe.join("\n") + "\necho probed\n");
    await request.put(`/api/sessions/${keel.id}/permissions`, { data: { mode: "full-auto", sandbox: "off" } });
    const PROBE = "bash probe.sh > probe.out 2>&1; tail -n 1 probe.out";
    await request.post(`/api/sessions/${keel.id}/messages`, { data: { text: ask(`Run this command and end your turn: ${PROBE}`, `script:calls ${JSON.stringify([{ name: "Bash", input: { command: PROBE } }])}`) } });
    const probed = () => { try { return readFileSync(join(ws, "probe.out"), "utf8"); } catch { return ""; } };
    await expect.poll(() => probed().includes("probed"), { timeout: 60_000 }).toBe(true);
    const lines = probed().split("\n");
    const of = (label: string) => lines.find((l) => l.startsWith(`${label} `))?.slice(label.length + 1) ?? "";
    expect(of("/api/sessions").slice(0, 3)).toBe("200");
    expect(of("/api/automation").slice(0, 3)).toBe("200");
    for (const r of lists) expect({ r, names: of(r).includes(sid) }).toEqual({ r, names: false });
    // (Its resources are measured at each read: their status, and that the session is named nowhere but where the read named it.)
    named.forEach((r, i) => {
      const [a, b] = [of(`A${i}`), of(`B${i}`).replaceAll(none, sid)];
      if (r.startsWith("/api/resources")) expect({ r, status: a.slice(0, 3) }).toEqual({ r, status: b.slice(0, 3) });
      else expect({ r, answer: a }).toEqual({ r, answer: b });
    });
    expect(probed()).not.toContain(`config loader ${tag}`);
    expect(probed()).not.toContain(`readConfig ${tag}`);
    expect(probed()).not.toContain("Marked unread");
    // The owner still has it, and its alert and snooze.
    expect((await sessionOf())?.id).toBe(sid);
    const auto = await (await request.get("/api/automation")).json();
    expect((auto.alerts as any[]).some((a) => a.session_id === sid)).toBe(true);
    expect((auto.snoozes as any[]).some((x) => x.session_id === sid)).toBe(true);
    await request.delete(`/api/sessions/${sid}/snooze`);
    await request.post("/api/alerts/read", { data: { session_id: sid } });
    rmSync(ws, { recursive: true, force: true });

    // In Settings > Storage the session is tagged as the other harness's copy.
    await request.get("/api/storage?refresh=1");
    await page.goto("/settings/storage");
    const stored = page.getByTestId("storage-session").filter({ hasText: `Rename the config loader ${tag}` });
    await expect(stored.getByTestId("storage-outside")).toHaveText("Claude Code");
    await page.goto(`/s/${sid}`);
    await expect(page.getByTestId("outside-bar")).toBeVisible();

    // One press: a Keel session that goes on with it.
    await page.getByTestId("outside-copy").click();
    await expect(page).not.toHaveURL(new RegExp(`/s/${sid}$`));
    const copy = new URL(page.url()).pathname.split("/").pop()!;
    made.push(copy);
    await expect(page.getByTestId("outside-bar")).toHaveCount(0);
    await expect(page.getByTestId("composer")).toBeVisible();
    await expect(page.getByText(`Renamed to readConfig ${tag}, with the old name kept.`).first()).toBeVisible();

    // Settings: whether Keel watches at all, folders left out, how far back a folder counts, when a silent one is stale.
    await page.goto("/settings/elsewhere");
    const panel = page.getByTestId("outside-settings");
    await expect(panel.getByTestId("outside-enabled")).toHaveAttribute("aria-checked", "true");
    await expect(panel.getByTestId("outside-watching")).toContainText("Watching");
    await panel.getByTestId("outside-exclude-input").fill(cwd);
    await panel.getByTestId("outside-exclude-add").click();
    await expect(panel.getByTestId("outside-excluded")).toContainText(`outside-${tag}`);
    await panel.getByTestId("outside-days").fill("0");
    await panel.getByTestId("outside-days").press("Enter");
    await expect(page.getByTestId("outside-settings-error")).toContainText("days is a whole number");
    await expect(panel.getByTestId("outside-days")).toHaveValue("30");
    await shoot(page, "outside-settings");
    await panel.getByRole("button", { name: `Show sessions in ${cwd} again` }).click();
    await expect(panel.getByTestId("outside-excluded")).toHaveCount(0);

    // The source has no session of its own once it is copied: its row left the list, and the copy carries it.
    await expect.poll(async () => await sessionOf()).toBeUndefined();
    await expect(row).toHaveCount(0);
    await expect(page.getByTestId("session-list").locator(`[data-testid="session-row"][data-session="${copy}"]`)).toHaveCount(1);
    await page.goto(`/s/${copy}`);
    await expect(page.getByTestId("origin-mark")).toContainText("From Claude Code");

    // It goes on there: the copy says it still runs, and past the stale time it says nothing of it. What it
    // wrote since is offered as resuming the import on the copy, never a row of its own.
    write({ type: "user", message: { role: "user", content: `And the tests ${tag}` } });
    reply("m5", [{ type: "tool_use", id: "t5", name: "Bash", input: { command: "make test" } }]);
    await expect(page.getByTestId("live-source")).toContainText("still runs in Claude Code", { timeout: 15_000 });
    await shoot(page, "outside-copy-source-runs");
    expect((await request.patch("/api/settings", { data: { outside: { stale_minutes: 0.05 } } })).ok()).toBe(true);
    await expect(page.getByTestId("live-source")).toHaveCount(0, { timeout: 20_000 });
    expect(await sessionOf()).toBeUndefined();
    await page.getByTestId("origin-resume").click();
    await expect(page.getByTestId("transcript").getByText(`And the tests ${tag}`).first()).toBeVisible();
    await expect(page.getByTestId("origin-resume")).toHaveCount(0);
    await shoot(page, "outside-copy-resumed");

    // The other harness's file holds what it wrote, and nothing of Keel's.
    const hash = (s: string) => createHash("sha256").update(s).digest("hex");
    expect(hash(readFileSync(path, "utf8"))).toBe(hash(written.map((l) => l + "\n").join("")));
  } finally {
    await request.patch("/api/settings", { data: { outside: { stale_minutes: null, exclude: null } } });
    for (const s of made) await request.delete(`/api/sessions/${s}`);
    rmSync(dir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});
