import { expect, test } from "./isolate.ts";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { daemon, exited, ROOT, sessionsFolder, TACIT_STANDIN } from "./own-daemon.ts";
import { shoot } from "./shots.ts";

// Feature: the helper's daily sweep of the memory systems. Once a day it reads Keel's own records
// of how each system did (what the memory store gave and a turn named, the helper's records, the
// model's native memory folder, the supervisor's nudges), writes a card in Settings > Usage > Memory
// (and the helper's panel), and offers up to three improvements. An offer changes something only
// when it is pressed; a note to the memory store shows its command first.
// The spec runs a daemon of its own on a state folder it seeded (test/e2e/fixtures/sweep-rows.ts).
test("the daily sweep: a card with a figure per system, and offers applied only when pressed", async ({ page }) => {
  const state = join(ROOT, `sweep-${Date.now()}`);
  const store = join(state, "tacit-store");
  const log = join(state, "tacit.log");
  mkdirSync(store, { recursive: true });
  const env = { TACIT_BIN: TACIT_STANDIN, TACIT_STANDIN_STORE: store, TACIT_STANDIN_LOG: log };
  const memory = join(dirname(sessionsFolder(state)), ".claude", "projects", "e2e", "memory");
  // The first start makes the tables; the rows go in while the daemon is stopped.
  const first = await daemon(state, 0, false, env);
  first.proc.kill();
  await exited(first.proc);
  execFileSync("bun", [join(import.meta.dirname, "fixtures/sweep-rows.ts"), state, memory]);
  const d = await daemon(state, 0, false, env);
  try {
    expect((await (await fetch(`${d.url}/api/memory/sweep`)).json()).card).toBeNull();
    await page.setViewportSize({ width: 1920, height: 1040 });
    await page.goto(`${d.url}/settings/usage?view=memory&tab=sweep`);
    await expect(page.getByTestId("sweep-none")).toBeVisible();
    await shoot(page, "memory-sweep-01-empty");
    await page.getByTestId("sweep-run").click();

    // A figure per system, from the seeded day.
    const by = (id: string) => page.locator(`[data-testid="sweep-system"][data-system="${id}"]`);
    // Each system's next step stands in the row's own area under it.
    const next = (id: string) => page.locator(`[data-testid="sweep-next"][data-system="${id}"]`);
    await expect(by("tacit")).toContainText("2 recalls, 10 facts");
    await expect(by("tacit")).toContainText("4 of 10 facts named");
    await expect(by("tacit").getByTestId("sweep-helped")).toHaveText("40%");
    await expect(by("helper")).toContainText("1 of 2 recalls used");
    await expect(by("helper").getByTestId("sweep-helped")).toHaveText("50%");
    // Claude's auto memory: five sessions loaded it; one read its note, of the two with later steps one named
    // its fact and one ran the call its correction note forbids.
    await expect(by("claude")).toContainText("loaded in 5 sessions");
    await expect(by("claude")).toContainText("2 of 3 facts used");
    await expect(by("claude").getByTestId("sweep-repeats")).toHaveText("1 repeat");
    await expect(by("claude").getByTestId("sweep-helped")).toHaveText("67%");
    await expect(next("claude")).toContainText('"git stash" ran after a note forbade it in 1 session');
    await expect(by("tacit").getByTestId("sweep-repeats")).toHaveText("none");
    await expect(by("codex")).toContainText("no session has loaded it yet");
    await expect(by("codex").getByTestId("sweep-helped")).toHaveCount(0);
    await expect(by("momentum")).toContainText("1 nudge");
    // Its one nudge was never delivered into a turn: unobserved, not a success.
    await expect(by("momentum")).toContainText("1 not seen yet");
    await expect(next("tacit")).toContainText("code-word");

    // Three offers: the stale record, the fact never named, the index that misses a note.
    const offers = page.getByTestId("sweep-offer");
    await expect(offers).toHaveCount(3);
    const offer = (kind: string) => page.locator(`[data-testid="sweep-offer"][data-kind="${kind}"]`);
    await expect(offer("drop_record")).toContainText("pref.coffee");
    await expect(offer("tacit_note")).toContainText("code-word");
    await expect(offer("tidy_index")).toContainText("1 note not listed");
    await shoot(page, "memory-sweep-02-card");

    // Nothing changed yet: the record and the index are as seeded.
    expect(readFileSync(join(memory, "MEMORY.md"), "utf8")).not.toContain("feedback_tests");
    expect((await (await fetch(`${d.url}/api/helper/memory`)).json()).items.map((r: any) => r.key)).toContain("pref.coffee");

    // Pressed: the record is forgotten, the index lists the note, the offer says what was done.
    await offer("drop_record").getByTestId("sweep-apply").click();
    await expect(offer("drop_record")).toHaveAttribute("data-state", "applied");
    expect((await (await fetch(`${d.url}/api/helper/memory`)).json()).items.map((r: any) => r.key)).not.toContain("pref.coffee");
    await offer("tidy_index").getByTestId("sweep-apply").click();
    await expect(offer("tidy_index")).toHaveAttribute("data-state", "applied");
    expect(readFileSync(join(memory, "MEMORY.md"), "utf8")).toContain("- [feedback_tests](feedback_tests.md): run the focused tests, not the suite");

    // A note to the memory store shows its command first; Cancel sends nothing, Send does.
    expect(existsSync(log) ? readFileSync(log, "utf8") : "").not.toContain("add ");
    await offer("tacit_note").getByTestId("sweep-apply").click();
    const confirm = page.getByTestId("confirm");
    await expect(confirm.getByTestId("confirm-code")).toContainText("add --harness claude");
    await expect(confirm.getByTestId("confirm-code")).toContainText("code-word-correction");
    await expect(confirm.getByTestId("confirm-code")).toContainText("daily memory sweep");
    await expect(confirm.getByTestId("confirm-code")).not.toContainText("marked wrong in Keel");
    await shoot(page, "memory-sweep-03-confirm");
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect(offer("tacit_note")).toHaveAttribute("data-state", "open");
    expect(existsSync(log) ? readFileSync(log, "utf8") : "").not.toContain("add ");
    await offer("tacit_note").getByTestId("sweep-apply").click();
    await expect(confirm.getByRole("button", { name: "Send note" })).toBeEnabled({ timeout: 10_000 });
    await confirm.getByRole("button", { name: "Send note" }).click();
    await expect(offer("tacit_note")).toHaveAttribute("data-state", "applied");
    expect(readFileSync(log, "utf8")).toContain("add claude code-word-correction");
    await shoot(page, "memory-sweep-04-applied");

    // The card is kept: a reload shows it with the states.
    await page.reload();
    await expect(page.getByTestId("sweep-offer")).toHaveCount(3);
    await expect(page.locator('[data-testid="sweep-offer"][data-state="applied"]')).toHaveCount(3);

    // The helper's panel says it in one quiet line, and its Details open the card.
    await page.goto(`${d.url}/`);
    await page.getByTestId("open-helper").click();
    const line = page.getByTestId("sweep-line");
    await expect(line).toContainText("tacit 40%");
    await expect(line).toContainText("Claude 67%, 1 repeat");
    await expect(page.getByTestId("sweep-systems")).toHaveCount(0);
    await shoot(page, "memory-sweep-05-helper-line");
    await line.getByTestId("sweep-line-open").click();
    await expect(page.getByTestId("sweep-systems")).toBeVisible();
  } finally {
    d.proc.kill();
    await exited(d.proc);
    rmSync(state, { recursive: true, force: true });
    rmSync(`${state}-ws`, { recursive: true, force: true });
  }
});
