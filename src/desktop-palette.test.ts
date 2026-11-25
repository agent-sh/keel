// The desktop app's tray draws a coloured dot before each session line (desktop/src/tray.rs). Its
// colors are the state palette's, written there as sRGB, because the menu takes a picture. This holds
// the two to each other: a token changed in the stylesheet fails here until the tray follows.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../ui/src/styles.css", import.meta.url), "utf8");
const tray = readFileSync(new URL("../desktop/src/tray.rs", import.meta.url), "utf8");

function oklchToHex(l: number, c: number, h: number): string {
  const a = c * Math.cos((h * Math.PI) / 180), b = c * Math.sin((h * Math.PI) / 180);
  const l_ = l + 0.3963377774 * a + 0.2158037573 * b, m_ = l - 0.1055613458 * a - 0.0638541728 * b, s_ = l - 0.0894841775 * a - 1.291485548 * b;
  const [L, M, S] = [l_ ** 3, m_ ** 3, s_ ** 3];
  const lin = [4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S, -1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S, -0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S];
  const enc = (x: number) => { x = Math.min(1, Math.max(0, x)); return Math.round(255 * (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055)); };
  return lin.map(enc).map((v) => v.toString(16).padStart(2, "0")).join("");
}

// The value of a token in the light block (its first line) or the night block (the one after `.dark {`).
function token(name: string, night: boolean): string {
  const from = night ? css.indexOf("\n.dark {") : 0;
  const m = new RegExp(`--${name}:\\s*([^;]+);`).exec(css.slice(from));
  if (!m) throw new Error(`--${name} not found`);
  const ref = /^var\(--([\w-]+)\)$/.exec(m[1]!.trim());
  return ref ? token(ref[1]!, night) : m[1]!.trim();
}
const hex = (name: string, night: boolean) => {
  const m = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(token(name, night));
  if (!m) throw new Error(`--${name} is not an oklch color: ${token(name, night)}`);
  return oklchToHex(Number(m[1]), Number(m[2]), Number(m[3]));
};
const rust = (name: string) => {
  const m = new RegExp(`const ${name}: u32 = 0x([0-9a-f]{6});`).exec(tray);
  if (!m) throw new Error(`${name} not found in tray.rs`);
  return m[1]!;
};

test("the tray's dots are the state palette's colors, in both themes", () => {
  expect(css).toContain("\n.dark {");
  expect({
    LIGHT_WORK: rust("LIGHT_WORK"), LIGHT_NEED: rust("LIGHT_NEED"), LIGHT_NEED_EDGE: rust("LIGHT_NEED_EDGE"), LIGHT_UNREAD: rust("LIGHT_UNREAD"),
    DARK_WORK: rust("DARK_WORK"), DARK_NEED: rust("DARK_NEED"), DARK_UNREAD: rust("DARK_UNREAD"),
  }).toEqual({
    LIGHT_WORK: hex("dot-work", false), LIGHT_NEED: hex("dot-need", false), LIGHT_NEED_EDGE: hex("dot-need-edge", false), LIGHT_UNREAD: hex("dot-unread", false),
    DARK_WORK: hex("dot-work", true), DARK_NEED: hex("dot-need", true), DARK_UNREAD: hex("dot-unread", true),
  });
});
