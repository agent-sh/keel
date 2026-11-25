// The helper's name and picture. The owner names it and gives it a face: a picture an image model of their own
// providers made from a short description they can edit (a few to pick from), or one they upload. The chosen
// picture is kept in the state folder (`helper/avatar.<ext>`), the candidates beside it until one is picked
// or the next ask replaces them. Everything the helper says and shows takes the name and the picture from here.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fitImage } from "../engine/image-fit.ts";
import { imageSize } from "../engine/images.ts";
import type { MadeImage } from "../providers/types.ts";
import { MAX_PICTURES, sniff } from "../providers/images.ts";

export const DEFAULT_NAME = "Helper";
export const NAME_CHARS = 40;
// The picture as kept: its longest side, and how much of it. A face in a list is small; 512 px is sharp on a
// phone's header and small enough to send with every page that shows it.
export const AVATAR_EDGE = 512;
export const AVATAR_BASE64 = 700_000;
// What an upload may be before it is looked at.
export const UPLOAD_BYTES = 10 * 1024 * 1024;
export const PROMPT_CHARS = 600;
const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
const TYPE: Record<string, string> = { png: "image/png", jpg: "image/jpeg", webp: "image/webp" };

// What the owner may change of the helper's look, kept with its state.
export type Persona = {
  name?: string;
  // The picture kept (its file is helper/avatar.<ext>), where it came from, and a mark that changes with it.
  avatar?: { ext: string; v: string; from: "made" | "upload"; model?: string; prompt?: string; ts: number };
  // The description and the model the owner last asked pictures with, offered again next time.
  avatar_prompt?: string;
  avatar_model?: string;
  candidates?: Candidate[];
};
export type Candidate = { id: string; ext: string; model: string; prompt: string; ts: number };

// The name as it is kept: one line, trimmed, at most NAME_CHARS characters. Undefined for what is not a name
// (empty, or lines and control characters).
export function cleanName(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const t = raw.replace(/\s+/g, " ").trim();
  if (!t || /[\p{Cc}\u2028\u2029]/u.test(t)) return undefined;
  return Array.from(t).length > NAME_CHARS ? undefined : t;
}

export const nameOf = (p: Persona) => p.name || DEFAULT_NAME;

// The description a picture is asked with: what the owner wrote, or a start for it when they wrote nothing,
// then the lines that keep the result usable as a small round picture.
export function startPrompt(name: string): string {
  return `A friendly cartoon character called ${name}: a small, helpful assistant with a clear expressive face, flat bright colors, simple shapes.`;
}
export const PROMPT_FRAME = "Head and shoulders, centered on a plain background, no text, no letters, no logo, square picture that reads well when small and round.";
export const askedWith = (description: string) => `${description.trim()}\n${PROMPT_FRAME}`;

export function cleanPrompt(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const t = raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim();
  return t && Array.from(t).length <= PROMPT_CHARS ? t : undefined;
}

// A picture as it is kept: within the limits above, in a format every page reads. Undefined with the reason.
export async function keepable(bytes: Uint8Array): Promise<{ ext: string; bytes: Uint8Array } | { error: string }> {
  if (!bytes.length) return { error: "the picture is empty" };
  if (bytes.length > UPLOAD_BYTES) return { error: `the picture is over ${UPLOAD_BYTES / 1024 / 1024} MB` };
  const data = Buffer.from(bytes).toString("base64");
  if (!sniff(data) && !imageSize(data)) return { error: "it is not a PNG, JPEG or WebP picture" };
  const f = await fitImage({ type: "image", media_type: sniff(data) ?? "image/png", data }, { edge: AVATAR_EDGE, base64: AVATAR_BASE64, formats: ["image/png", "image/jpeg", "image/webp"] });
  if ("refused" in f) return { error: `the picture ${f.refused}` };
  return { ext: EXT[f.block.media_type] ?? "png", bytes: Buffer.from(f.block.data, "base64") };
}

export class PersonaFiles {
  constructor(private dir: string) {}

  private get candidates() { return join(this.dir, "candidates"); }
  private put(path: string, bytes: Uint8Array) {
    mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(path, bytes, { mode: 0o600 });
  }

  avatarPath(ext: string) { return join(this.dir, `avatar.${ext}`); }
  candidatePath(c: Pick<Candidate, "id" | "ext">) { return join(this.candidates, `${c.id}.${c.ext}`); }
  type(ext: string) { return TYPE[ext] ?? "application/octet-stream"; }

  read(path: string): Uint8Array | undefined {
    try { return existsSync(path) ? readFileSync(path) : undefined; } catch { return undefined; }
  }

  // The chosen picture replaces the one kept (whatever its format).
  keep(ext: string, bytes: Uint8Array): string {
    for (const e of Object.values(EXT)) rmSync(this.avatarPath(e), { force: true });
    this.put(this.avatarPath(ext), bytes);
    return Bun.hash(bytes).toString(36);
  }
  remove() {
    for (const e of Object.values(EXT)) rmSync(this.avatarPath(e), { force: true });
  }

  // A new ask replaces the candidates of the one before.
  clearCandidates() {
    rmSync(this.candidates, { recursive: true, force: true });
  }
  addCandidates(made: { ext: string; bytes: Uint8Array }[], model: string, prompt: string, ts: number): Candidate[] {
    this.clearCandidates();
    return made.slice(0, MAX_PICTURES).map((m, i) => {
      const c: Candidate = { id: `${ts.toString(36)}${i}`, ext: m.ext, model, prompt, ts };
      this.put(this.candidatePath(c), m.bytes);
      return c;
    });
  }
  // Candidates whose file is gone are not offered.
  present(list: Candidate[]): Candidate[] {
    return list.filter((c) => existsSync(this.candidatePath(c)));
  }
  leftovers(): string[] {
    try { return readdirSync(this.candidates); } catch { return []; }
  }
}

// The pictures an image maker returned, each kept as the limits allow; the ones that cannot be are left out
// (the first reason is given when none can).
export async function keepAll(made: MadeImage[]): Promise<{ ext: string; bytes: Uint8Array }[] | { error: string }> {
  const out: { ext: string; bytes: Uint8Array }[] = [];
  let why = "";
  for (const m of made) {
    const k = await keepable(Buffer.from(m.data, "base64"));
    if ("error" in k) why ||= k.error;
    else out.push(k);
  }
  return out.length ? out : { error: why || "no picture came back" };
}
