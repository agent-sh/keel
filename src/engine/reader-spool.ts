// A multi-part reading keeps only answer ranges in memory between requests.
// The unlinked file closes with the job (or the daemon), even on abort.
import { mkdir, open, unlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { conceal } from "../core/conceal.ts";

export type AnswerRange = { at: number; bytes: number; chars: number };

export class ReaderSpool {
  private file?: Promise<FileHandle>;
  private end = 0;

  constructor(private dir: string, private session?: string) {}

  private async make() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const path = join(this.dir, `.readers-${Bun.randomUUIDv7()}`);
    const file = await open(path, "wx+", 0o600);
    try { await unlink(path); } catch (e) { await file.close(); throw e; }
    return file;
  }

  async put(text: string): Promise<AnswerRange> {
    // Nothing kept outside the store may hold a secret value.
    text = conceal(text, this.session);
    const b = Buffer.from(text);
    const at = this.end;
    this.end += b.length;
    const file = await (this.file ??= this.make());
    for (let n = 0; n < b.length; ) {
      const { bytesWritten } = await file.write(b, n, b.length - n, at + n);
      if (!bytesWritten) throw new Error("could not write a reader's findings");
      n += bytesWritten;
    }
    return { at, bytes: b.length, chars: text.length };
  }

  async get(p: AnswerRange): Promise<string> {
    const b = Buffer.allocUnsafe(p.bytes);
    const file = await this.file!;
    for (let n = 0; n < b.length; ) {
      const { bytesRead } = await file.read(b, n, b.length - n, p.at + n);
      if (!bytesRead) throw new Error("could not read a reader's findings");
      n += bytesRead;
    }
    return b.toString();
  }

  async close() { await this.file?.then((fp) => fp.close(), () => {}); }
}
