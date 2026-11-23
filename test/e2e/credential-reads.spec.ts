import { expect, test } from "./isolate.ts";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ROOT, daemon, exited, sessionsFolder } from "./own-daemon.ts";
import { shoot } from "./shots.ts";

// Feature: where credentials are kept is a class for the file tools as for the
// shell's reads (src/safety/credentials.ts). A search of a folder leaves out
// what holds credentials; a read of one asks the owner; what the owner lets it
// read reaches the model only as placeholders. The spec runs its own daemon,
// whose home holds made-up credentials, and reads every request the scripted
// stand-in was sent (KEEL_SCRIPTED_BODY_LOG).
test("a credential file is read only when the owner allows it, and its values never reach a model", async ({ page }) => {
  test.setTimeout(120_000);
  const state = join(ROOT, `credential-reads-${Date.now()}`), st = join(state, "state");
  // (The daemon's home is the folder its sessions' folder is in: own-daemon.ts.)
  const work = sessionsFolder(st), home = dirname(work);
  // Made-up values, put together here so no file of the repository holds one whole.
  const netrc = ["Planted", "7Token", "9Value", "3x"].join(""), env = ["Planted", "Env", "4Secret", "8q2"].join("");
  mkdirSync(join(home, ".aws"), { recursive: true });
  writeFileSync(join(home, ".netrc"), `machine example.invalid login me password ${netrc}\n`);
  writeFileSync(join(home, ".aws/credentials"), `[default]\nregion = us-east-1\n# Planted for the search\n`);
  writeFileSync(join(work, ".env"), `DB_PASS ${env}\nPlanted=1\n`);
  writeFileSync(join(work, ".env.example"), "DB_PASS changeme\nPlanted=1\n");
  writeFileSync(join(work, "notes.txt"), "Planted notes, nothing secret\n");
  mkdirSync(state, { recursive: true });
  const log = join(state, "bodies.jsonl");
  const d = await daemon(st, 0, false, { KEEL_SCRIPTED_BODY_LOG: log });
  const call = (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") =>
    fetch(d.url + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }).then((r) => r.json() as any);
  try {
    const { session } = await call("/api/sessions", { model: "scripted:claude-stand-in", workspace: work, title: "Reads near credentials" });
    await call(`/api/sessions/${session.id}/permissions`, { mode: "ask", sandbox: "off" }, "PUT");
    const calls = [
      // A search of the home and of the folder: nothing that holds credentials is searched or shown.
      { name: "Grep", input: { pattern: "Planted", path: home, output_mode: "content" } },
      // An example file is not a credential: it is read as before.
      { name: "Read", input: { file_path: join(work, ".env.example") } },
      // A credential file named by itself: the owner's card.
      { name: "Read", input: { file_path: join(home, ".netrc") } },
    ];
    await page.setViewportSize({ width: 1920, height: 1040 });
    await page.goto(`${d.url}/s/${session.id}`);
    await page.getByTestId("composer").fill(`script:calls ${JSON.stringify(calls)}`);
    await page.keyboard.press("Enter");
    const card = page.getByTestId("approval");
    await expect(card).toBeVisible({ timeout: 60_000 });
    await expect(card).toContainText("~/.netrc, where the owner's credentials are kept");
    await shoot(page, "credential-read-card");
    await card.getByTestId("allow-once").click();
    await expect(page.getByTestId("turn-end")).toHaveCount(1, { timeout: 60_000 });

    const results = (await call(`/api/sessions/${session.id}`)).events.filter((e: any) => e.kind === "tool_result" || e.kind === "user").flatMap((e: any) => JSON.stringify(e.data));
    const said = results.join("\n");
    expect(said).toContain("notes.txt");
    expect(said).toContain("Left out");
    expect(said).toContain("DB_PASS changeme");
    expect(said).toMatch(/password \[secret:[0-9a-f]{8}\]/);
    await shoot(page, "credential-read-done");

    // Every request the model was sent: the made-up values are in none of them, the search's notes are.
    const sent = existsSync(log) ? readFileSync(log, "utf8") : "";
    expect(sent.split("\n").filter(Boolean).length).toBeGreaterThan(1);
    expect(sent.includes(netrc), "the .netrc password reached a model").toBe(false);
    expect(sent.includes(env), "the .env value reached a model").toBe(false);
    expect(sent).toContain("Planted notes");
  } finally {
    d.proc.kill("SIGTERM");
    await exited(d.proc);
  }
});
