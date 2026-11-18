// Fonts load as separate files, latin and latin-ext only, each fetched the
// first time a character in its range is drawn. (An @font-face in the CSS
// would be inlined into the stylesheet as base64 by the bundler: every
// subset of both families, about 250 KB gzip, on the first load.)
import monoLatinExt from "@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-ext-wght-normal.woff2";
import monoLatin from "@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2";
import plexLatinExt from "@fontsource-variable/ibm-plex-sans/files/ibm-plex-sans-latin-ext-wght-normal.woff2";
import plexLatin from "@fontsource-variable/ibm-plex-sans/files/ibm-plex-sans-latin-wght-normal.woff2";
// Direction faces: each loads only when its direction draws text with it.
import martian from "@fontsource-variable/martian-mono/files/martian-mono-latin-standard-normal.woff2";
import newsreader from "@fontsource-variable/newsreader/files/newsreader-latin-wght-normal.woff2";
import newsreaderItalic from "@fontsource-variable/newsreader/files/newsreader-latin-wght-italic.woff2";
import schibsted from "@fontsource-variable/schibsted-grotesk/files/schibsted-grotesk-latin-wght-normal.woff2";

const LATIN = "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD";
const LATIN_EXT = "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF";

const faces: [string, string, string, string][] = [
  ["IBM Plex Sans Variable", plexLatin, LATIN, "100 700"],
  ["IBM Plex Sans Variable", plexLatinExt, LATIN_EXT, "100 700"],
  ["JetBrains Mono Variable", monoLatin, LATIN, "100 800"],
  ["JetBrains Mono Variable", monoLatinExt, LATIN_EXT, "100 800"],
];
for (const [family, url, unicodeRange, weight] of faces) {
  const f = new FontFace(family, `url(${url}) format("woff2")`, { unicodeRange, weight, display: "swap" });
  document.fonts.add(f);
  if (unicodeRange === LATIN) f.load().catch(() => {});
}

const directionFaces: { family: string; url: string; weight: string; style?: string; stretch?: string; direction: string }[] = [
  { family: "Martian Mono Variable", url: martian, weight: "100 800", stretch: "75% 112.5%", direction: "bridge" },
  { family: "Newsreader Variable", url: newsreader, weight: "200 800", direction: "wake" },
  { family: "Newsreader Variable", url: newsreaderItalic, weight: "200 800", style: "italic", direction: "wake" },
  { family: "Schibsted Grotesk Variable", url: schibsted, weight: "400 900", direction: "watch" },
];
const active = document.documentElement.dataset.direction;
for (const d of directionFaces) {
  const f = new FontFace(d.family, `url(${d.url}) format("woff2")`, { unicodeRange: LATIN, weight: d.weight, style: d.style ?? "normal", stretch: d.stretch ?? "100%", display: "swap" });
  document.fonts.add(f);
  if (d.direction === active) f.load().catch(() => {});
}
