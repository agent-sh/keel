// Terminal escapes out of text: CSI sequences, OSC ended by BEL or ESC \, and
// two-character escapes. Pure; the page and the daemon both use it.
export const stripAnsi = (s: string) => s.replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[@-Z\\-_]/g, "");
