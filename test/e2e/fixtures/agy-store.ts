// bun test/e2e/fixtures/agy-store.ts <agy home> <cwd> <conversation id> <word>: an Antigravity conversation in its
// command line store (the e2e runs under node; bun:sqlite is bun's). Prints the transcript's path.
import { agySession } from "./import-stores.ts";
console.log(agySession(process.argv[2]!, process.argv[3]!, process.argv[4]!, process.argv[5]!));
