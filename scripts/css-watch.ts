// Dev only: Bun's dev bundler rebuilds the stylesheet when ui/src/styles.css
// changes but not when a file it imports does. When any other stylesheet under
// ui/src changes, this writes styles.css back with its own bytes (a content
// write: the bundler's watcher ignores a bare mtime change), and exits with the
// daemon.
import { readFileSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "ui", "src");
const entry = join(root, "styles.css");
const parent = Number(process.argv[2] ?? process.ppid);
let pending: ReturnType<typeof setTimeout> | undefined;
watch(root, { recursive: true }, (_, file) => {
  if (!file || !file.endsWith(".css") || join(root, file) === entry) return;
  clearTimeout(pending);
  pending = setTimeout(() => writeFileSync(entry, readFileSync(entry)), 30);
});
setInterval(() => { try { process.kill(parent, 0); } catch { process.exit(0); } }, 2000);
