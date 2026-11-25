// Whether this browser held anything of Keel's before this load, read when the page starts (main.tsx
// imports this first). A part of the page that loads later (the list) would otherwise find what the
// start itself had written and take a first visit for a return.
export const returning = (() => { for (let i = 0; i < localStorage.length; i++) if (localStorage.key(i)!.startsWith("keel.")) return true; return false; })();
