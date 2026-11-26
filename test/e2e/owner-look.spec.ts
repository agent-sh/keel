import { expect, test } from "./isolate.ts";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HAIKU, LIST_ORDER, shoot } from "./shots.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });

// The scratch repository's picture command: a picture of the card at each size Keel names, and with KEEL_LOOK
// one more, named by the look it was given (a box in the card's color, written with node:zlib, no browser).
const PIC = String.raw`
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
const out = process.env.KEEL_PICTURES_OUT;
const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (k, body) => { const o = Buffer.alloc(12 + body.length); o.writeUInt32BE(body.length, 0); o.write(k, 4, "latin1"); body.copy(o, 8); o.writeUInt32BE(crc(o.subarray(4, 8 + body.length)), 8 + body.length); return o; };
function png(w, h, px) {
  const raw = Buffer.alloc(h * (w * 3 + 1));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set(px(x, y), y * (w * 3 + 1) + 1 + x * 3);
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ih), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const color = /COLOR = "#([0-9a-f]{6})"/.exec(readFileSync("ui/src/Card.tsx", "utf8"))[1];
const rgb = [0, 2, 4].map((i) => parseInt(color.slice(i, i + 2), 16));
const take = (shot, W, H) => {
  writeFileSync(out + "/" + shot, png(Math.round(W / 8), Math.round(H / 8), (x, y) => (x >= 4 && x < 40 && y >= 4 && y < 20 ? rgb : [246, 247, 249])));
  appendFileSync(out + "/shots.tsv", shot + "\t" + process.argv[2] + "\n");
};
for (const size of process.env.KEEL_SHOT_SIZES.split(",").filter(Boolean)) take("card-" + size + "-light.png", ...size.split("x").map(Number));
if (process.env.KEEL_LOOK) {
  const l = JSON.parse(process.env.KEEL_LOOK);
  take("card-look-" + l.width + "x" + l.height + "-" + l.view + "-" + l.scale + "-" + l.theme + ".png", l.width, l.height);
}
`;

// Feature: the owner's look. A page tells the daemon on its socket how it is drawn: its view (the workbench or
// Focus), its text scale, its theme, its window size and its engine; the daemon keeps the newest of each kind of
// client and names the owner's (GET /api/looks). A page in the workbench at text scale 0.9 in the light theme at
// 1320x860 is read back as that, a change of view is told as it happens, and a pictures run of a repository whose
// .keel/pictures.json names "owner" among its sizes takes a picture at that look on both sides.
test("the daemon knows how the owner's page is drawn, and a change's pictures are taken at it", async ({ browser, request, baseURL }) => {
  test.setTimeout(120_000);
  const origin = new URL(baseURL ?? process.env.KEEL_URL!).origin;
  const ctx = await browser.newContext({
    viewport: { width: 1320, height: 860 },
    storageState: { cookies: [], origins: [{ origin, localStorage: [
      { name: "keel.workbench", value: "true" }, { name: "keel.listArrange", value: LIST_ORDER },
      { name: "keel.textScale", value: "0.9" }, { name: "keel.theme", value: "light" },
    ] }] },
  });
  const page = await ctx.newPage();
  // (The picture command runs as the session's commands do: with no approval to ask for. The fixture puts the mode back.)
  await request.put("/api/permissions/settings", { data: { default_mode: "full-auto" } });
  try {
    const s = (await (await request.post("/api/sessions", { data: { model: HAIKU, title: "Owner's look" } })).json()).session.id as string;
    await page.goto(`${origin}/s/${s}`);
    await expect(page.getByTestId("composer")).toBeVisible();
    const owner = async () => (await (await request.get("/api/looks")).json()).owner;
    await expect.poll(owner).toMatchObject({ kind: "browser", view: "workbench", scale: 0.9, theme: "light", width: 1320, height: 860, engine: "browser", phone: false });
    await shoot(page, "owner-look-workbench");

    // Focus by its keys: told as it happens, and back.
    await page.keyboard.press("Control+.");
    await expect.poll(async () => (await owner()).view).toBe("focus");
    await page.keyboard.press("Control+.");
    await expect.poll(async () => (await owner()).view).toBe("workbench");

    // A repository whose pictures name the owner's look: a branch that changes the card.
    const repo = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `owner-look-${Date.now()}`, "repo");
    mkdirSync(join(repo, "ui/src"), { recursive: true });
    mkdirSync(join(repo, "test/e2e"), { recursive: true });
    mkdirSync(join(repo, ".keel"));
    writeFileSync(join(repo, "ui/src/Card.tsx"), `const COLOR = "#3366cc";\nexport const Card = () => <div data-testid="card" style={{ color: COLOR }} />;\n`);
    writeFileSync(join(repo, "test/e2e/card.spec.ts"), `await page.getByTestId("card").click();\nawait shoot(page, "card");\n`);
    writeFileSync(join(repo, "pic.mjs"), PIC);
    writeFileSync(join(repo, ".keel/pictures.json"), JSON.stringify({ run: "bun pic.mjs", pages: ["ui/"], specs: ["test/e2e/*.spec.ts"], sizes: ["1920x1040", "owner"], themes: ["light"], harness: ["pic.mjs"] }));
    git(repo, "init", "-q", "-b", "main");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "init");
    git(repo, "checkout", "-qb", "green-card");
    execFileSync("sed", ["-i", "s/#3366cc/#22aa55/", "ui/src/Card.tsx"], { cwd: repo });
    git(repo, "commit", "-qam", "Make the card green");

    const lane = (await (await request.post("/api/sessions", { data: { model: HAIKU, workspace: repo, title: "Green card" } })).json()).session.id as string;
    const started = (await (await request.get(`/api/sessions/${lane}/pictures`)).json()).run;
    expect(started).toBeTruthy();
    await expect.poll(async () => (await (await request.get(`/api/pictures/${started.id}`)).json()).run.state, { timeout: 90_000 }).not.toMatch(/^(queued|running)$/);
    const run = (await (await request.get(`/api/pictures/${started.id}`)).json()).run;
    expect([run.state, run.why]).toEqual(["done", null]);
    expect(run.look).toMatchObject({ view: "workbench", scale: 0.9, theme: "light", width: 1320, height: 860 });
    expect(run.pairs.map((p: any) => [p.name, p.state]).sort()).toEqual([["card-1920x1040-light.png", "changed"], ["card-look-1320x860-workbench-0.9-light.png", "changed"]]);
    expect((await request.get(`/api/pictures/${run.id}/after/card-look-1320x860-workbench-0.9-light.png`)).headers()["content-type"]).toBe("image/png");
  } finally {
    await ctx.close();
  }
});
