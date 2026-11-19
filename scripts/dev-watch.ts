// Dev only, beside `bun --hot` (scripts/dev.sh); exits with the daemon.
// - Bun's dev bundler rebuilds the stylesheet when ui/src/styles.css changes
//   but not when a file it imports does: when any other stylesheet under
//   ui/src changes, styles.css is written back with its own bytes (a content
//   write: the bundler's watcher ignores a bare mtime change).
// - `bun --hot` stops watching a source file that went missing and came back
//   (a rebase or checkout passing through a commit without it, a stash): later
//   edits to it reload nothing. When a file under src/ appears, src/main.ts is
//   written back with its own bytes: the reload that follows watches the whole
//   module graph again.
// - A changed package.json or bun.lock (a lane added a dependency) runs
//   `bun install` first, so the reload finds the new package.
import { readFileSync, watch, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const top = join(import.meta.dir, "..");
const ui = join(top, "ui", "src");
const src = join(top, "src");
const styles = join(ui, "styles.css");
const entry = join(src, "main.ts");
const parent = Number(process.argv[2] ?? process.ppid);
const rewrite = (f: string) => writeFileSync(f, readFileSync(f));
const debounce = (ms: number, f: () => void | Promise<void>) => {
  let t: ReturnType<typeof setTimeout> | undefined;
  return () => { clearTimeout(t); t = setTimeout(f, ms); };
};

const css = debounce(30, () => rewrite(styles));
watch(ui, { recursive: true }, (_, file) => {
  if (file?.endsWith(".css") && join(ui, file) !== styles) css();
});

let install = false;
const reload = debounce(300, async () => {
  if (install) {
    install = false;
    await Bun.spawn(["bun", "install", "--silent"], { cwd: top, stdout: "inherit", stderr: "inherit" }).exited;
  }
  rewrite(entry);
});
watch(src, { recursive: true }, (kind, file) => {
  if (kind === "rename" && file && /\.tsx?$/.test(file) && existsSync(join(src, file))) reload();
});
watch(top, (_, file) => {
  if (file === "package.json" || file === "bun.lock") { install = true; reload(); }
});
setInterval(() => { try { process.kill(parent, 0); } catch { process.exit(0); } }, 2000);
