import { expect, test } from "./isolate.ts";
import type { Page } from "@playwright/test";

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
