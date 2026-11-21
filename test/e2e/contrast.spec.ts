import { expect, test } from "./isolate.ts";
import type { Page } from "./isolate.ts";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openPanel, shoot } from "./shots.ts";

// Feature: the color tokens read on every surface they are used on, in both
// themes. Warn text (a caption, or a chip on its own tint) has 4.5:1 against
// what is behind it, and the focus ring has 3:1 against the surface it is
// drawn on. Measured from the colors the browser paints, not from the token
// values, so a token outside sRGB is counted as it is shown.
const SURFACES = ["bg-bg", "bg-panel", "bg-raised", "bg-sunken"] as const;

// The contrast of each probe on each surface, both themes. A probe is the
// classes of the element whose color is read (its own background, if any, is
// painted first), or a CSS color to paint over the surface.
async function measure(page: Page, probes: { name: string; classes?: string; color?: string }[]) {
  return page.evaluate(({ probes, surfaces }) => {
    const cv = document.createElement("canvas");
    cv.width = cv.height = 1;
    const ctx = cv.getContext("2d", { willReadFrequently: true })!;
    // Paints the colors one over the other and reads the pixel: what the screen shows, in sRGB.
    const flat = (...colors: string[]) => {
      ctx.clearRect(0, 0, 1, 1);
      for (const c of colors) { ctx.fillStyle = c; ctx.fillRect(0, 0, 1, 1); }
      return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3);
    };
    const lum = (c: number[]) => {
      const [r, g, b] = c.map((v) => { const x = v / 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; });
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    const ratio = (a: number[], b: number[]) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
    const out: { theme: string; surface: string; probe: string; ratio: number }[] = [];
    const root = document.documentElement;
    const was = root.classList.contains("dark");
    for (const theme of ["light", "dark"]) {
      root.classList.toggle("dark", theme === "dark");
      for (const surface of surfaces) {
        for (const p of probes) {
          const box = document.createElement("div");
          box.className = surface;
          const el = document.createElement("span");
          el.className = p.classes ?? "";
          el.textContent = "probe";
          box.append(el);
          document.body.append(box);
          const under = getComputedStyle(box).backgroundColor;
          const own = getComputedStyle(el).backgroundColor;
          const behind = flat(under, own);
          const drawn = flat(under, own, p.color ? getComputedStyle(root).getPropertyValue(p.color) : getComputedStyle(el).color);
          out.push({ theme, surface, probe: p.name, ratio: Math.round(ratio(drawn, behind) * 100) / 100 });
          box.remove();
        }
      }
    }
    root.classList.toggle("dark", was);
    return out;
  }, { probes, surfaces: SURFACES });
}

test("warn text reads on every surface in both themes", async ({ page }) => {
  await page.goto("/settings/general");
  await page.getByTestId("text-size").waitFor();
  const got = await measure(page, [
    { name: "caption", classes: "text-caption text-warn" },
    { name: "chip", classes: "bg-warn/15 text-micro text-warn" },
  ]);
  console.log(got.map((g) => `${g.theme} ${g.surface} ${g.probe} ${g.ratio}`).join("\n"));
  expect(got).toHaveLength(16);
  expect(got.filter((g) => g.ratio < 4.5)).toEqual([]);
  // An icon in the warn color is a mark, not a word: it keeps the amber fill, and so does a bar (the context arc).
  for (const dark of [false, true]) {
    const c = await page.evaluate((dark) => {
      const root = document.documentElement;
      const was = root.classList.contains("dark");
      root.classList.toggle("dark", dark);
      const mk = (tag: string, cls: string) => { const el = document.createElementNS("http://www.w3.org/2000/svg", tag); el.setAttribute("class", cls); document.body.append(el); return el; };
      const icon = mk("svg", "text-warn"), arc = mk("svg", "stroke-warn");
      const word = Object.assign(document.createElement("span"), { className: "text-warn" }), fill = Object.assign(document.createElement("span"), { className: "bg-warn" });
      document.body.append(word, fill);
      const out = { icon: getComputedStyle(icon).color, arc: getComputedStyle(arc).stroke, word: getComputedStyle(word).color, fill: getComputedStyle(fill).backgroundColor };
      for (const el of [icon, arc, word, fill]) el.remove();
      root.classList.toggle("dark", was);
      return out;
    }, dark);
    expect(c.icon).toBe(c.fill);
    expect(c.arc).toBe(c.fill);
    if (!dark) expect(c.word).not.toBe(c.fill);
  }
});

// The other amber words: brass text (a caption, a chip on brass-soft) and the
// "working" state word of a session row, a rail card and a station head. In
// light they take the same ink as warn text; their icons keep the fill.
test("amber state words and brass text read on every surface in both themes", async ({ page }) => {
  await page.goto("/settings/general");
  await page.getByTestId("text-size").waitFor();
  const got = await measure(page, [
    { name: "brass caption", classes: "text-caption text-brass" },
    { name: "brass chip", classes: "bg-brass-soft text-micro text-brass" },
    { name: "working word", color: "--st-work-ink" },
  ]);
  console.log(got.map((g) => `${g.theme} ${g.surface} ${g.probe} ${g.ratio}`).join("\n"));
  expect(got).toHaveLength(24);
  expect(got.filter((g) => g.ratio < 4.5)).toEqual([]);
  // The state words really wear that ink, and a brass icon keeps the brass fill.
  for (const dark of [false, true]) {
    const c = await page.evaluate((dark) => {
      const root = document.documentElement;
      const was = root.classList.contains("dark");
      root.classList.toggle("dark", dark);
      const box = document.createElement("div");
      box.innerHTML = `<div class="k-row" data-watch="work"><span class="k-row-state">w</span></div><div class="k-rail-card" data-watch="work"><span class="k-rail-card-word">w</span></div><div class="k-station" data-watch="work"><span class="k-station-word">w</span></div><i style="color: var(--st-work-ink)">ink</i><svg class="text-brass"></svg><b class="bg-brass">fill</b>`;
      document.body.append(box);
      const color = (sel: string) => getComputedStyle(box.querySelector(sel)!).color;
      const out = { words: [".k-row-state", ".k-rail-card-word", ".k-station-word"].map(color), ink: color("i"), icon: color("svg"), fill: getComputedStyle(box.querySelector("b")!).backgroundColor };
      box.remove();
      root.classList.toggle("dark", was);
      return out;
    }, dark);
    expect(c.words).toEqual([c.ink, c.ink, c.ink]);
    expect(c.icon).toBe(c.fill);
  }
});

// The ring is drawn on the surface around the control (offset out of it), so
// the surface is what it has to stand off from: the grey rail and panels too.
test("the focus ring stands off every surface in both themes", async ({ page }) => {
  await page.goto("/settings/general");
  await page.getByTestId("text-size").waitFor();
  const got = await measure(page, [{ name: "ring", color: "--ring" }]);
  console.log(got.map((g) => `${g.theme} ${g.surface} ${g.probe} ${g.ratio}`).join("\n"));
  expect(got).toHaveLength(8);
  expect(got.filter((g) => g.ratio < 3)).toEqual([]);
  // The ring a control really gets is that token, two pixels wide.
  await page.getByTestId("text-size").getByRole("radio", { checked: true }).focus();
  await page.keyboard.press("ArrowRight");
  const ring = await page.locator(":focus").evaluate((el) => { const c = getComputedStyle(el); return { style: c.outlineStyle, width: c.outlineWidth }; });
  expect(ring.style).toBe("solid");
  expect(ring.width).toBe("2px");
});

// Every word the owner reads has 4.5:1 (3:1 for large text) in both themes:
// the quiet text tokens and the state colors used as words on each surface,
// and, on a real session with its Changes panel open, every text node on
// screen: the list's faint text, an earlier turn's stats (its icons step back,
// its words do not), a diff's line numbers and signs.
test("every text reads in both themes, an earlier turn's stats and a diff's line numbers too", async ({ page, request }) => {
  await page.goto("/settings/general");
  await page.getByTestId("text-size").waitFor();
  const tokens = await measure(page, ["faint", "muted", "danger", "ok", "st-fail", "st-done", "st-need", "accent-ink"].map((t) => ({ name: t, classes: `text-caption text-${t}` })));
  expect(tokens).toHaveLength(64);
  expect(tokens.filter((g) => g.ratio < 4.5)).toEqual([]);

  const model = process.env.KEEL_TEST_MODEL ?? "scripted:stand-in";
  test.skip(!model.startsWith("scripted:"), "the turns are scripted");
  const ws = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `contrast-${Date.now()}`);
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(ws, "a.ts"), "// A comment.\nexport const a = 1;\nexport const b = 2;\n");
  execFileSync("git", ["init", "-q"], { cwd: ws });
  const { session } = await (await request.post("/api/sessions", { data: { workspace: ws, model, title: "Contrast of every text" } })).json();
  await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto" } });
  const turns = async (n: number) => expect.poll(async () => {
    const r = await (await request.get(`/api/sessions/${session.id}`)).json();
    return !r.running && r.events.filter((e: any) => e.kind === "turn_end").length;
  }, { timeout: 60_000 }).toBe(n);
  await request.post(`/api/sessions/${session.id}/messages`, { data: { text: `Change the file. script:calls ${JSON.stringify([{ name: "Edit", input: { file_path: join(ws, "a.ts"), old_string: "export const b = 2;", new_string: "export const b = 3;\nexport const c = 4;" } }])}` } });
  await turns(1);
  await request.post(`/api/sessions/${session.id}/messages`, { data: { text: "And say it is done." } });
  await turns(2);
  await page.goto(`/s/${session.id}`);
  await openPanel(page, "changes");
  await page.locator(".k-diff-no").first().waitFor();
  await expect(page.getByTestId("turn-end")).toHaveCount(2);
  // The panel has faded in: nothing is read half way through its entrance.
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running" || a.effect?.getComputedTiming().iterations === Infinity));

  const scan = () => page.evaluate(() => {
    const cv = document.createElement("canvas");
    cv.width = cv.height = 1;
    const ctx = cv.getContext("2d", { willReadFrequently: true })!;
    const rgba = (css: string) => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = "#000"; ctx.fillStyle = css; ctx.fillRect(0, 0, 1, 1); const d = ctx.getImageData(0, 0, 1, 1).data; return [d[0]!, d[1]!, d[2]!, d[3]! / 255]; };
    const over = (f: number[], b: number[]) => [0, 1, 2].map((i) => f[i]! * f[3]! + b[i]! * (1 - f[3]!)).concat(1);
    const lum = (c: number[]) => { const v = c.slice(0, 3).map((u) => { u /= 255; return u <= 0.04045 ? u / 12.92 : ((u + 0.055) / 1.055) ** 2.4; }); return 0.2126 * v[0]! + 0.7152 * v[1]! + 0.0722 * v[2]!; };
    const ratio = (a: number[], b: number[]) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x! + 0.05) / (y! + 0.05); };
    // What is painted behind an element: every background up to the first opaque one, composed.
    const behind = (el: Element) => {
      const stack: number[][] = [];
      for (let p: Element | null = el; p; p = p.parentElement) { const c = rgba(getComputedStyle(p).backgroundColor); if (c[3]! > 0) stack.push(c); if (c[3] === 1) break; }
      let b = rgba(getComputedStyle(document.body).backgroundColor);
      for (const c of stack.reverse()) b = over(c, b);
      return b;
    };
    const low: string[] = [];
    const seen = new Set<Element>();
    let texts = 0, stats = 0, numbers = 0;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = n.textContent!.trim();
      const el = n.parentElement;
      if (!t || !el || seen.has(el) || el.closest("[disabled],[aria-disabled=true]")) continue;
      seen.add(el);
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
      const s = getComputedStyle(el);
      if (s.visibility === "hidden") continue;
      let op = 1;
      for (let p: Element | null = el; p; p = p.parentElement) op *= Number(getComputedStyle(p).opacity);
      if (!op) continue;
      texts++;
      if (el.closest('[data-testid="turn-end"]')) stats++;
      if (el.closest(".k-diff-no")) numbers++;
      const fg = rgba(s.color);
      fg[3] = fg[3]! * op;
      const bg = behind(el);
      const cr = ratio(over(fg, bg), bg);
      const px = parseFloat(s.fontSize);
      const big = px >= 24 || (px >= 18.66 && Number(s.fontWeight) >= 700);
      if (cr < (big ? 3 : 4.5)) low.push(`${Math.round(cr * 100) / 100} "${t.slice(0, 30)}" ${el.tagName.toLowerCase()}.${String(el.className).slice(0, 60)}`);
    }
    return { texts, stats, numbers, low };
  });
  for (const theme of ["light", "dark"]) {
    await page.evaluate((t) => { document.documentElement.classList.add("theme-switch"); document.documentElement.classList.toggle("dark", t === "dark"); }, theme);
    const got = await scan();
    console.log(`${theme}: ${got.texts} texts, ${got.stats} in turn stats, ${got.numbers} line numbers, ${got.low.length} under the ratio\n${got.low.join("\n")}`);
    // The earlier turn's stats and the diff's numbers were on screen and counted.
    expect(got.stats).toBeGreaterThan(3);
    expect(got.numbers).toBeGreaterThan(2);
    expect(got.low).toEqual([]);
  }
  await page.evaluate(() => document.documentElement.classList.remove("theme-switch"));
  await shoot(page, "contrast-every-text");
});

// The light theme has contrast of surface: steel frames the work (the rail),
// paper is the page, white is what is worked on (a card, a side panel). On
// Settings the rail, the section list and a card are not three greys, and a
// side panel is not a slab of the rail's color.
test("the light theme steps from steel to paper to white", async ({ page, request }) => {
  await page.setViewportSize({ width: 1920, height: 1040 });
  await page.goto("/settings/general");
  await page.getByTestId("text-size").waitFor();
  await page.evaluate(() => { document.documentElement.classList.add("theme-switch"); document.documentElement.classList.remove("dark"); });
  // The luminance of what is painted behind an element.
  const lumOf = (sel: string) => page.locator(sel).first().evaluate((el) => {
    const cv = document.createElement("canvas");
    cv.width = cv.height = 1;
    const ctx = cv.getContext("2d", { willReadFrequently: true })!;
    let color = "";
    for (let p: Element | null = el; p; p = p.parentElement) { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = getComputedStyle(p).backgroundColor; ctx.fillRect(0, 0, 1, 1); if (ctx.getImageData(0, 0, 1, 1).data[3] === 255) { color = getComputedStyle(p).backgroundColor; break; } }
    const d = ctx.getImageData(0, 0, 1, 1).data;
    const [r, g, b] = [d[0]!, d[1]!, d[2]!].map((v) => { const x = v / 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; });
    return { color, lum: 0.2126 * r! + 0.7152 * g! + 0.0722 * b! };
  });
  const step = (a: { lum: number }, b: { lum: number }) => Math.round(((Math.max(a.lum, b.lum) + 0.05) / (Math.min(a.lum, b.lum) + 0.05)) * 1000) / 1000;
  const rail = await lumOf(".k-rail"), list = await lumOf(".k-settings-rail"), body = await lumOf(".k-settings-body"), card = await lumOf(".k-settings-body .k-card");
  console.log(`rail ${rail.color}; section list ${list.color}; page ${body.color}; card ${card.color}; rail to page ${step(rail, body)}, page to card ${step(body, card)}`);
  expect(list.color).toBe(body.color);
  expect(step(rail, body)).toBeGreaterThanOrEqual(1.12);
  expect(step(body, card)).toBeGreaterThanOrEqual(1.06);
  expect(card.lum).toBeGreaterThan(body.lum);
  expect(body.lum).toBeGreaterThan(rail.lum);

  const model = process.env.KEEL_TEST_MODEL ?? "scripted:stand-in";
  const { session } = await (await request.post("/api/sessions", { data: { model, title: "Surfaces in light" } })).json();
  await page.goto(`/s/${session.id}`);
  await openPanel(page, "files");
  await page.evaluate(() => { document.documentElement.classList.add("theme-switch"); document.documentElement.classList.remove("dark"); });
  const side = await lumOf('[data-testid="side-panel"]');
  expect(side.color).toBe(card.color);
  expect(step(rail, side)).toBeGreaterThanOrEqual(1.2);
  await shoot(page, "contrast-surfaces");
});
