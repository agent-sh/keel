// What a reader cannot see in a text, or what changes how it looks: hidden
// characters (spelled out), letters written right to left (shown in their
// runs), look-alikes (named). The daemon reads the same of every approval, so
// the logic is its module, read here too (src/safety/chars.ts): the page, the
// phone, an editor and a terminal are told the same of a text.
export { hasHidden, hasRtl, lookAlikes, plainAscii, rtlRuns, spellHidden, type Piece } from "../../../src/safety/chars.ts";
