// Dev only: Bun's dev bundler rebuilds the stylesheet when ui/src/styles.css
// changes but not when a file it imports does. This touches styles.css when
// any other stylesheet under ui/src changes, and exits with the daemon.
import { utimesSync, watch } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "ui", "src");
const entry = join(root, "styles.css");
const parent = Number(process.argv[2] ?? process.ppid);
watch(root, { recursive: true }, (_, file) => {
  if (!file || !file.endsWith(".css") || join(root, file) === entry) return;
  const now = new Date();
  utimesSync(entry, now, now);
});
setInterval(() => { try { process.kill(parent, 0); } catch { process.exit(0); } }, 2000);
