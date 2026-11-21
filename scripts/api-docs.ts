// Writes docs/http-api.md from the stable route table (src/server/stable-api.ts).
// Run it after changing that table: bun scripts/api-docs.ts
import { join } from "node:path";
import { renderApiDoc } from "../src/server/stable-api.ts";

const out = join(import.meta.dir, "../docs/http-api.md");
await Bun.write(out, renderApiDoc());
console.log(`wrote ${out}`);
