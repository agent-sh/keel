import { expect, test } from "./isolate.ts";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HAIKU, ask, openPanel, shoot } from "./shots.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });

// The scratch repository's picture command: for each spec it is given, and each size and theme Keel names, a
// picture of that spec's component (a box in the color its file holds), listed with its spec in shots.tsv.
// Every picture has a stamp drawn from the run's instant (KEEL_PICTURES_FIXED: without it, a time of its own
// differs on every side, as a page's clock does), and the card and the clock have a corner of random pixels
// that differs on every run whatever is fixed (as a name a spec makes from its own time does). A PNG is written with nothing
// but node:zlib, so the run needs no browser.
const PIC = String.raw`
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
const out = process.env.KEEL_PICTURES_OUT;
const at = Number(process.env.KEEL_PICTURES_FIXED || Date.now() + Math.random());
const stamp = [at % 251, (at >> 3) % 241, (at >> 6) % 239];
const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (k, body) => { const o = Buffer.alloc(12 + body.length); o.writeUInt32BE(body.length, 0); o.write(k, 4, "latin1"); body.copy(o, 8); o.writeUInt32BE(crc(o.subarray(4, 8 + body.length)), 8 + body.length); return o; };
function png(w, h, px) {
  const raw = Buffer.alloc(h * (w * 3 + 1));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set(px(x, y), y * (w * 3 + 1) + 1 + x * 3);
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ih), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
for (const spec of process.argv.slice(2)) {
  const name = spec.split("/").pop().replace(".spec.ts", "");
  const file = "ui/src/" + name[0].toUpperCase() + name.slice(1) + ".tsx";
  const color = /COLOR = "#([0-9a-f]{6})"/.exec(readFileSync(file, "utf8"))[1];
  const rgb = [0, 2, 4].map((i) => parseInt(color.slice(i, i + 2), 16));
  const noisy = name !== "header";
  for (const size of process.env.KEEL_SHOT_SIZES.split(",")) for (const theme of process.env.KEEL_SHOT_THEMES.split(",")) {
    const [W, H] = size.split("x").map(Number);
    const w = Math.round(W / 4), h = Math.round(H / 4);
    const bg = theme === "dark" ? [24, 26, 32] : [246, 247, 249];
    // (Black or white at random a pixel: every 8-pixel cell of it differs between two runs, all but never.)
    const edge = Math.floor(w / 8) * 8; // (whole 8-pixel cells: a cell of 4 pixels agrees between two runs one time in 16)
    const corner = () => (Math.random() < 0.5 ? [0, 0, 0] : [255, 255, 255]);
    const shot = name + "-" + size + "-" + theme + ".png";
    writeFileSync(out + "/" + shot, png(w, h, (x, y) => (noisy && x >= edge - 32 && x < edge && y >= 8 && y < 16 ? corner() : x < 12 && y >= h - 10 ? stamp : x >= 20 && x < 80 && y >= 30 && y < 60 ? rgb : bg)));
    appendFileSync(out + "/shots.tsv", shot + "\t" + spec + "\n");
  }
}
console.log("pictures taken");
`;

// Feature: before and after pictures of a branch that changes the page, taken when someone looks. A
// repository names its pictures (.keel/pictures.json: its page folder, its specs, a command, two sizes and two
// themes). A coordinator starts two agents: one changes the card's color and touches the header and the clock
// without changing how they look, one changes only a spec. Nothing is taken when they end, and their reports
// say nothing of pictures. Opening the card's pictures on the work board takes them: Keel picks the three specs
// that look for the changed components' test ids, runs the command on the merge base (with the branch's
// harness) and on the head, with the run's own instant on both, pairs the pictures by name and outlines the
// changed area. The pairs that still differ are checked against a second run of the base with only their
// specs: the card's corner moves from run to run and is left out of its change, the clock moves only there
// and is unstable, the header (its stamp from the run's instant) is the same and is not taken again. The
// second agent's Review panel opening takes nothing: only tests changed.
test("a branch that changes the page gets before and after pictures with the change outlined", async ({ page, request }) => {
  test.setTimeout(180_000);
  await request.put("/api/permissions/settings", { data: { default_mode: "full-auto" } });
  const repo = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `pictures-${Date.now()}`, "repo");
  mkdirSync(join(repo, "ui/src"), { recursive: true });
  mkdirSync(join(repo, "test/e2e"), { recursive: true });
  mkdirSync(join(repo, ".keel"));
  for (const [name, color] of [["Card", "3366cc"], ["Header", "aa3344"], ["Clock", "557788"]] as const) {
    writeFileSync(join(repo, `ui/src/${name}.tsx`), `const COLOR = "#${color}";\nexport const ${name} = () => <div data-testid="${name.toLowerCase()}" style={{ color: COLOR }} />;\n`);
    writeFileSync(join(repo, `test/e2e/${name.toLowerCase()}.spec.ts`), `await page.getByTestId("${name.toLowerCase()}").click();\nawait shoot(page, "${name.toLowerCase()}");\n`);
  }
  writeFileSync(join(repo, "pic.mjs"), PIC);
  writeFileSync(join(repo, ".keel/pictures.json"), JSON.stringify({ run: "bun pic.mjs", pages: ["ui/"], specs: ["test/e2e/*.spec.ts"], sizes: ["1920x1040", "390x844"], themes: ["light", "dark"], harness: ["pic.mjs"] }));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");

  const idle = (id: string) => expect.poll(async () => { const d = await (await request.get(`/api/sessions/${id}`)).json(); return !d.running && d.events.at(-1)?.kind === "turn_end"; }, { timeout: 90_000 }).toBe(true);
  const calls = (list: unknown[]) => `script:calls ${JSON.stringify(list)}`;
  const bash = (command: string) => ({ name: "Bash", input: { command } });
  const commit = (cmd: string, msg: string) => `${cmd} && git -c user.name=k -c user.email=k@k commit -qam '${msg}'`;
  const lane = (title: string, cmd: string) => ({ name: "spawn_agent", input: { message: `${title}\n${calls([bash(cmd)])}` } });
  const coord = (await (await request.post("/api/sessions", { data: { model: HAIKU, workspace: repo, title: "Coordinator" } })).json()).session.id as string;
  await request.post(`/api/sessions/${coord}/messages`, { data: { text: ask("Start two agents: one makes the card green, one renames the header spec's picture.", `script:batch ${JSON.stringify([
    lane("Card color", commit("sed -i 's/#3366cc/#22aa55/' ui/src/Card.tsx && echo '// the header' >> ui/src/Header.tsx && echo '// the clock' >> ui/src/Clock.tsx", "Make the card green")),
    lane("Spec only", commit("sed -i 's/\"header\")/\"header-top\")/' test/e2e/header.spec.ts", "Rename the header picture")),
  ])}`) } });
  const agentsOf = async () => (await (await request.get(`/api/sessions/${coord}/agents`)).json()).agents as any[];
  await expect.poll(async () => (await agentsOf()).filter((a) => a.status === "completed" && a.branch).length, { timeout: 90_000 }).toBe(2);
  const card = (await agentsOf()).find((a) => a.title === "Card color")!;
  const spec = (await agentsOf()).find((a) => a.title === "Spec only")!;
  await idle(coord);

  // Nothing was taken when they ended: the card's branch changes the page and its pictures wait to be opened;
  // the spec's changes no page file and has none. Neither report says anything of pictures.
  const board = async () => (await (await request.get(`/api/sessions/${coord}/board?fresh=1`)).json()) as any;
  const rowOf = (b: any, id: string) => b.rows.find((r: any) => r.id === id);
  let b = await board();
  expect(rowOf(b, card.id).pictures).toMatchObject({ state: "none", id: 0, head: rowOf(b, card.id).head });
  expect(rowOf(b, spec.id).pictures ?? null).toBeNull();
  for (const a of await agentsOf()) expect(String(a.result ?? "")).not.toContain("Pictures");

  // The Board panel: the card's pictures, not taken yet; opening them takes them.
  await page.goto(`/s/${coord}`);
  await openPanel(page, "board");
  const row = page.getByTestId("work-board").locator(`[data-testid="board-row"][data-agent="${card.id}"]`);
  const fact = row.getByTestId("board-pictures");
  await expect(fact).toHaveAttribute("data-state", "none");
  await expect(page.getByTestId("work-board").locator(`[data-testid="board-row"][data-agent="${spec.id}"]`).getByTestId("board-pictures")).toHaveCount(0);
  await row.scrollIntoViewIfNeeded();
  await shoot(page, "pictures-board-none");
  await fact.getByTestId("pictures-open").click();
  await expect(fact).toHaveAttribute("data-state", "done", { timeout: 90_000 });

  b = await board();
  const pics = rowOf(b, card.id).pictures;
  expect(pics).toMatchObject({ counts: { changed: 4, unstable: 4, new: 0, gone: 0, same: 4, unread: 0 }, specs: ["test/e2e/card.spec.ts", "test/e2e/clock.spec.ts", "test/e2e/header.spec.ts"], head: rowOf(b, card.id).head });
  // The changed area is outlined where the box is: 60x30 at (20, 30), in 8-pixel cells; the corner that moves on
  // every run is not in it.
  const first = pics.differ.find((p: any) => p.name === "card-1920x1040-light.png");
  expect(first.boxes).toEqual([{ x: 16, y: 24, w: 64, h: 40 }]);

  // The run is kept by its head, with each side's result; the base was taken again with only the specs whose
  // pictures still differed, and the files of the pairs that are the same are not kept.
  const run = (await (await request.get(`/api/pictures/${pics.id}`)).json()).run;
  expect([run.sides.before.state, run.sides.after.state, run.sides.again.state]).toEqual(["done", "done", "done"]);
  expect(run.sides.again.specs).toEqual(["test/e2e/card.spec.ts", "test/e2e/clock.spec.ts"]);
  const named = (state: string) => run.pairs.filter((p: any) => p.state === state).map((p: any) => p.name).sort();
  expect(named("same")).toEqual(["header-1920x1040-dark.png", "header-1920x1040-light.png", "header-390x844-dark.png", "header-390x844-light.png"]);
  expect(named("unstable")).toEqual(["clock-1920x1040-dark.png", "clock-1920x1040-light.png", "clock-390x844-dark.png", "clock-390x844-light.png"]);
  expect(run.pairs.filter((p: any) => p.state === "changed").every((p: any) => p.noise > 0)).toBe(true);
  expect((await request.get(`/api/pictures/${pics.id}/after/card-390x844-dark.png`)).headers()["content-type"]).toBe("image/png");
  expect((await request.get(`/api/pictures/${pics.id}/after/header-390x844-dark.png`)).status()).toBe(404);
  // Opening them again is the same run.
  expect((await (await request.get(`/api/sessions/${card.session_id}/pictures`)).json()).run.id).toBe(pics.id);

  // The card's first pair before beside after, outlined; Compare opens every pair.
  await expect(fact).toHaveAttribute("data-differ", "4");
  await expect(fact.getByTestId("pictures-line")).toContainText("4 of 12 differ, 4 unstable");
  await expect(fact.getByTestId("pictures-after").getByTestId("pictures-mark")).toHaveCount(1);
  await expect(fact.locator("img")).toHaveCount(2);
  await expect.poll(() => fact.locator("img").evaluateAll((imgs) => imgs.every((i) => (i as HTMLImageElement).naturalWidth > 0))).toBe(true);
  await shoot(page, "pictures-board");

  await fact.getByTestId("pictures-compare").click();
  const viewer = page.getByTestId("pictures-viewer");
  await expect(viewer.getByTestId("pictures-counts")).toHaveText("4 changed · 4 unstable · 0 new · 0 gone · 4 same");
  await expect(viewer.getByTestId("pictures-list").locator("li")).toHaveCount(8);
  await expect(viewer.getByTestId("pictures-name")).toHaveText("card-1920x1040-dark.png");
  await expect(viewer.getByTestId("pictures-pair").getByTestId("pictures-mark")).toHaveCount(2);
  // At 1920 a pair is as large as the pane holds: the pictures fill its height or its width.
  const fills = () => viewer.getByTestId("pictures-pair").evaluate((pair) => {
    const img = pair.querySelector("img")!.getBoundingClientRect(), box = pair.querySelector("figure > div")!.getBoundingClientRect();
    // (Within the picture's own border.)
    return Math.abs(img.height - box.height) < 3 || Math.abs(img.width - box.width) < 3;
  });
  await expect.poll(fills).toBe(true);
  await viewer.getByTestId("pictures-next").click();
  await expect(viewer.getByTestId("pictures-name")).toHaveText("card-1920x1040-light.png");
  await viewer.getByTestId("pictures-all").check();
  await expect(viewer.getByTestId("pictures-list").locator("li")).toHaveCount(12);
  await viewer.getByTestId("pictures-all").uncheck();
  // An unstable pair's areas are drawn dashed, not as a change.
  await viewer.getByTestId("pictures-list").locator("li").nth(4).click();
  await expect(viewer.getByTestId("pictures-name")).toHaveText("clock-1920x1040-dark.png");
  await expect(viewer.getByTestId("pictures-pair")).toHaveAttribute("data-state", "unstable");
  await expect(viewer.locator('[data-testid="pictures-mark"][data-kind="unstable"]')).toHaveCount(2);
  await viewer.getByTestId("pictures-list").locator("li").first().click();
  // The outlines go off and come back (as Chromatic's and Percy's overlays do).
  await viewer.getByTestId("pictures-marks").uncheck();
  await expect(viewer.getByTestId("pictures-pair").getByTestId("pictures-mark")).toHaveCount(0);
  await viewer.getByTestId("pictures-marks").check();
  await shoot(page, "pictures-viewer");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(viewer.getByTestId("pictures-pair")).toBeVisible();
  // On a phone the title wraps: none of it is cut.
  await expect.poll(() => viewer.locator("h2").first().evaluate((t) => t.scrollWidth <= t.clientWidth + 1)).toBe(true);
  await shoot(page, "pictures-viewer-phone");
  await page.setViewportSize({ width: 1920, height: 1040 });
  await page.keyboard.press("Escape");
  await expect(viewer).toHaveCount(0);

  // The tree review shows them with the branch, and opens the same pairs.
  await page.getByTestId("board-review-tree").click();
  const tree = page.getByTestId("tree-review");
  const branch = tree.locator(`[data-testid="tree-branch"][data-branch="${card.branch}"]`);
  await expect(branch.getByTestId("tree-pictures")).toHaveAttribute("data-differ", "4");
  await expect(branch.getByTestId("tree-pictures").getByTestId("pictures-mark")).toHaveCount(2);
  await expect(tree.locator(`[data-testid="tree-branch"][data-branch="${spec.branch}"]`).getByTestId("tree-pictures")).toHaveCount(0);
  await branch.getByTestId("tree-pictures").scrollIntoViewIfNeeded();
  await shoot(page, "pictures-tree");
  await branch.getByTestId("pictures-compare").click();
  await expect(page.getByTestId("pictures-viewer").getByTestId("pictures-counts")).toHaveText("4 changed · 4 unstable · 0 new · 0 gone · 4 same");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("pictures-viewer")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(tree).toHaveCount(0);

  // The agent's own Review panel shows the same run.
  await page.goto(`/s/${card.session_id}`);
  await openPanel(page, "review");
  await expect(page.getByTestId("review-pictures")).toHaveAttribute("data-differ", "4");
  await shoot(page, "pictures-review");

  // The spec's Review panel opening asks for its pictures: skipped, only tests changed, and nothing is shown.
  await page.goto(`/s/${spec.session_id}`);
  await openPanel(page, "review");
  await expect.poll(async () => rowOf(await board(), spec.id).pictures?.state, { timeout: 30_000 }).toBe("skipped");
  expect(rowOf(await board(), spec.id).pictures.why).toBe("only tests changed");
  await expect(page.getByTestId("review-pictures")).toHaveCount(0);
});
