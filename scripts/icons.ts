// The icon files, made from the one mark: `bun scripts/icons.ts` after a change of the mark or of the inks it
// reads from ui/src/styles.css. It writes the page's icon and the installed page's PNGs (ui/public) and the
// desktop app's two icons (desktop/assets). The path is also written out by hand where a file cannot be made
// from here: ui/src/components/Logo.tsx, desktop/src/tray.rs and page.rs, src/integrations/mobile/v1.ts, and
// android's ic_launcher_fg.xml, ic_stat.xml and ui/Parts.kt.
import { chromium } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
// A level waterline and the keel under it, on a grid of 24: one stroke, round ends and corners.
const D = "M2.5 6.5H8L11.5 17.5H14.5L15.5 6.5H21.5";
const POINTS: [number, number][] = [[2.5, 6.5], [8, 6.5], [11.5, 17.5], [14.5, 17.5], [15.5, 6.5], [21.5, 6.5]]; // its corners

// The stroke as a filled outline (a panel paints a symbolic icon through its fill): round caps, a round join on
// the outer side of a turn, a corner on the inner. `k` scales the result to another grid.
export function outline(pts: [number, number][], r: number, k = 1): string {
  const f = (v: number) => String(Math.round(v * k * 100) / 100);
  const n = pts.length - 1;
  const dir = pts.slice(0, n).map((p, i) => { const q = pts[i + 1]!; const l = Math.hypot(q[0] - p[0], q[1] - p[1]); return [(q[0] - p[0]) / l, (q[1] - p[1]) / l] as const; });
  const nm = dir.map(([x, y]) => [-y, x] as const);
  const at = (i: number, j: number, s: 1 | -1) => [pts[i]![0] + s * r * nm[j]![0], pts[i]![1] + s * r * nm[j]![1]] as const;
  const corner = (i: number, s: 1 | -1) => { const a = nm[i - 1]!, b = nm[i]!; const m = 1 + a[0] * b[0] + a[1] * b[1]; return [pts[i]![0] + (s * r * (a[0] + b[0])) / m, pts[i]![1] + (s * r * (a[1] + b[1])) / m] as const; };
  const cross = (i: number) => dir[i - 1]![0] * dir[i]![1] - dir[i - 1]![1] * dir[i]![0];
  let out = `M${f(at(0, 0, 1)[0])} ${f(at(0, 0, 1)[1])}`;
  const line = (p: readonly [number, number]) => { out += `L${f(p[0])} ${f(p[1])}`; };
  const arc = (p: readonly [number, number]) => { out += `A${f(r)} ${f(r)} 0 0 0 ${f(p[0])} ${f(p[1])}`; };
  for (let i = 1; i < n; i++) {
    if (cross(i) > 0) line(corner(i, 1));
    else { line(at(i, i - 1, 1)); arc(at(i, i, 1)); }
  }
  line(at(n, n - 1, 1)); arc(at(n, n - 1, -1));
  for (let i = n - 1; i >= 1; i--) {
    if (cross(i) < 0) line(corner(i, -1));
    else { line(at(i, i, -1)); arc(at(i, i - 1, -1)); }
  }
  line(at(0, 0, -1)); arc(at(0, 0, 1));
  return `${out}Z`;
}

if (import.meta.main) {
  // The inks, from the tokens: the muted ink of each theme for the bare mark, the night's page ground and ink
  // where a launcher needs a ground.
  const css = readFileSync(join(root, "ui/src/styles.css"), "utf8");
  const night = css.indexOf(".dark {");
  const token = (name: string, dark: boolean) => new RegExp(`--${name}: (oklch\\([^)]*\\));`).exec(dark ? css.slice(night) : css.slice(0, night))![1]!;
  const browser = await chromium.launch();
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  const hex = (color: string) => page.evaluate((color) => {
    const c = document.createElement("canvas"); c.width = c.height = 1;
    const g = c.getContext("2d")!; g.fillStyle = color; g.fillRect(0, 0, 1, 1);
    return "#" + [...g.getImageData(0, 0, 1, 1).data].slice(0, 3).map((v) => v.toString(16).padStart(2, "0")).join("");
  }, color);
  const ground = await hex(token("bg", true)), ink = await hex(token("fg", true));
  const quietDay = await hex(token("muted", false)), quietNight = await hex(token("muted", true));

  // The page's icon: the bare mark, a little heavier than in the rail (a tab draws it at 16 px), in the muted ink
  // of the browser's scheme.
  writeFileSync(join(root, "ui/public/icon.svg"), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="1 1 22 22"><style>path{stroke:${quietDay}}@media (prefers-color-scheme:dark){path{stroke:${quietNight}}}</style><path d="${D}" fill="none" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>\n`);

  // With a ground: the mark at `k` times its grid around (cx, cy).
  const mark = (cx: number, cy: number, k: number) => `<path transform="translate(${cx} ${cy}) scale(${k}) translate(-12 -12)" d="${D}" fill="none" stroke="${ink}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>`;
  writeFileSync(join(root, "desktop/assets/io.github.agent_sh.Keel.svg"), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <rect x="8" y="8" width="112" height="112" rx="27" fill="${ground}"/>
  <rect x="8.75" y="8.75" width="110.5" height="110.5" rx="26.25" fill="none" stroke="#ffffff" stroke-opacity="0.12" stroke-width="1.5"/>
  ${mark(64, 65, 3.4)}
</svg>
`);
  writeFileSync(join(root, "desktop/assets/io.github.agent_sh.Keel-symbolic.svg"), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="#222222">
  <path d="${outline(POINTS, 1.15, 2 / 3)}"/>
</svg>
`);

  // The installed page's icons. One of purpose "any" keeps rounded corners of its own; a maskable one and
  // Apple's are cut by the launcher, the mark inside the safe zone.
  const png = async (file: string, size: number, rx: number, k: number, alpha: boolean) => {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<body style="margin:0;background:${alpha ? "transparent" : ground}"><svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><rect width="${size}" height="${size}" rx="${rx}" fill="${ground}"/>${mark(size / 2, size / 2 + size / 128, size * k)}</svg></body>`);
    await page.screenshot({ path: join(root, "ui/public", file), omitBackground: alpha, clip: { x: 0, y: 0, width: size, height: size } });
  };
  await png("icon-192.png", 192, 44, 0.029, true);
  await png("icon-512.png", 512, 116, 0.029, true);
  await png("maskable-512.png", 512, 0, 0.024, false);
  await png("apple-touch-180.png", 180, 0, 0.028, false);
  await browser.close();
  console.log(`icons written: ground ${ground}, ink ${ink}, bare ${quietDay} by day and ${quietNight} by night`);
}
