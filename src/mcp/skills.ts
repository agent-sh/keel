// Skills served by MCP servers (the io.modelcontextprotocol/skills extension, SEP-2640; spec in
// modelcontextprotocol/ext-skills, specification/beta/skills.mdx). Pure rules here, the connection's part is in
// client.ts and the owner's allow and the loading are in manager.ts.
//
// What the extension makes Keel do:
// - Ask for `skills/list` once, after the server declared the extension (a modern server only) and never again by
//   itself. No file is read until a skill is loaded, a supporting file until it is read.
// - Identify a skill by its server and its URI. A name is a label: the model is offered `mcp:<server>:<name>`,
//   which no local skill or plugin skill of another name can take.
// - Allow a server's skills once, by the owner (the same pin as a server's tools and instructions, src/mcp/pins.ts).
//   The allow binds to each skill's manifest: every file URI and digest. A skill whose manifest differs from the
//   allowed one, one that is new, is held until the owner allows it; the model is offered nothing of it.
// - Verify what a read gives: its raw byte size and sha256 against the retained entry, and a SKILL.md's frontmatter
//   field by field against the entry's. Read only the files the retained manifest names.
// - A skill with `resources: "dynamic"` has no content to bind an allow to: it is declined.
// - What a skill asks of the host (allowed-tools, hooks, a model, fork) is not honored: it is text for the model.
import { createHash } from "node:crypto";
import { yamlWithin } from "../core/yaml-bound.ts";
import { canon } from "./config.ts";

export const SKILLS_EXTENSION = "io.modelcontextprotocol/skills";

// The most files a manifest may name here. The spec asks hosts to support 512 files and 16 MiB a skill.
export const FILES_MAX = 2048;
export const SKILL_BYTES_MAX = 64 * 1024 * 1024;
const FRONTMATTER_MAX = 64_000;

export type SkillFile = { uri: string; digest: string; size: number };
// An entry as the host retains it: the SKILL.md's URI, its frontmatter as the server gave it, the whole manifest.
// `fetched`: it came from skills/get for a URI the model or the owner named, not from the listing.
export type SkillEntry = { uri: string; frontmatter: Record<string, unknown>; files: SkillFile[]; fetched?: true };

const isObject = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const DIGEST = /^sha256:[0-9a-f]{64}$/;

// An entry as a listing gave it, or why it is not one Keel can use.
export function entryOf(raw: unknown): { entry: SkillEntry } | { problem: string } {
  if (!isObject(raw)) return { problem: "it is not an object" };
  const { uri, frontmatter, resources } = raw;
  if (typeof uri !== "string" || !uri) return { problem: "it has no uri" };
  if (!isObject(frontmatter) || typeof frontmatter.name !== "string" || !frontmatter.name || typeof frontmatter.description !== "string")
    return { problem: `${uri} has no name and description in its frontmatter` };
  if (/[\p{C}<>]/u.test(frontmatter.name)) return { problem: `${uri} has a name with characters a listing cannot carry` };
  if (resources === "dynamic") return { problem: `${uri} is generated, so no manifest binds an allow to it (resources: "dynamic")` };
  if (!Array.isArray(resources)) return { problem: `${uri} has no manifest` };
  if (resources.length > FILES_MAX) return { problem: `${uri} names ${resources.length} files, more than ${FILES_MAX}` };
  const files: SkillFile[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const f of resources) {
    if (!isObject(f) || typeof f.uri !== "string" || !f.uri || typeof f.digest !== "string" || !DIGEST.test(f.digest) || typeof f.size !== "number" || !Number.isSafeInteger(f.size) || f.size < 0)
      return { problem: `${uri} has a manifest entry that is not a uri, a sha256 digest and a size` };
    if (seen.has(f.uri)) return { problem: `${uri} names ${f.uri} twice` };
    seen.add(f.uri);
    total += f.size;
    files.push({ uri: f.uri, digest: f.digest, size: f.size });
  }
  if (total > SKILL_BYTES_MAX) return { problem: `${uri} is ${total} bytes, more than ${SKILL_BYTES_MAX}` };
  if (!seen.has(uri)) return { problem: `${uri} is not in its own manifest` };
  return { entry: { uri, frontmatter, files } };
}

// The skills of a listing that can be used, and one problem line for those that cannot.
export function entriesOf(raw: unknown[]): { entries: SkillEntry[]; problems: string[] } {
  const entries: SkillEntry[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    const e = entryOf(r);
    if ("problem" in e) problems.push(e.problem);
    else if (seen.has(e.entry.uri)) problems.push(`${e.entry.uri} is listed twice`);
    else { seen.add(e.entry.uri); entries.push(e.entry); }
  }
  return { entries, problems };
}

// What an allow binds to: every file's URI and digest, in one order. (A size follows from a digest.)
export const manifestDigest = (e: SkillEntry): string =>
  createHash("sha256").update(canon(e.files.map((f) => [f.uri, f.digest]).sort((a, b) => (a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : 0)))).digest("hex");

// The skills of a server the owner has not allowed as they are now: new, or with another manifest than the allowed one.
// `allowed`: the pin's record, URI to manifest digest (none: the owner never allowed this server's skills).
export type SkillChange = { uri: string; name: string; description: string; kind: "added" | "changed"; files: number; bytes: number; digest: string };
export const allowedSkill = (allowed: Record<string, string> | undefined, e: SkillEntry) => allowed?.[e.uri] === manifestDigest(e);
export function skillChanges(allowed: Record<string, string> | undefined, entries: SkillEntry[]): SkillChange[] {
  return entries.filter((e) => !allowedSkill(allowed, e)).map((e) => ({
    uri: e.uri, name: String(e.frontmatter.name), description: String(e.frontmatter.description), kind: allowed?.[e.uri] === undefined ? "added" as const : "changed" as const,
    files: e.files.length, bytes: e.files.reduce((n, f) => n + f.size, 0), digest: manifestDigest(e),
  }));
}
// What an allow of these entries records.
export const allowRecord = (entries: SkillEntry[]): Record<string, string> => Object.fromEntries(entries.map((e) => [e.uri, manifestDigest(e)]));

// The name the model is offered a skill by. Two skills of one server with one name are told apart by their paths.
export function labelsOf(server: string, entries: SkillEntry[]): Map<string, string> {
  const names = new Map<string, number>();
  for (const e of entries) names.set(String(e.frontmatter.name), (names.get(String(e.frontmatter.name)) ?? 0) + 1);
  const out = new Map<string, string>();
  const taken = new Set<string>();
  for (const e of entries) {
    const name = String(e.frontmatter.name);
    let label = `mcp:${server}:${names.get(name)! > 1 ? pathOf(e.uri) : name}`;
    for (let n = 2; taken.has(label); n++) label = `${label.replace(/#\d+$/, "")}#${n}`;
    taken.add(label);
    out.set(e.uri, label);
  }
  return out;
}
// A skill's URI without its scheme and its SKILL.md: `skill://team/review/SKILL.md` is `team/review`.
export const pathOf = (uri: string) => uri.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/\/SKILL\.md$/i, "");

// What a file read gave, as bytes: a text as UTF-8, a blob from its base64.
export function bytesOf(item: { text?: unknown; blob?: unknown }): Uint8Array | undefined {
  if (typeof item.text === "string") return new TextEncoder().encode(item.text);
  if (typeof item.blob === "string") return new Uint8Array(Buffer.from(item.blob, "base64"));
  return undefined;
}

// A file as read against the manifest's word of it, or why it is not to be used.
export function verifyFile(bytes: Uint8Array, f: SkillFile): string | undefined {
  if (bytes.length !== f.size) return `${f.uri} is ${bytes.length} bytes, its manifest says ${f.size}`;
  const got = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (got !== f.digest) return `${f.uri} does not match the digest in its manifest`;
}

// A SKILL.md's frontmatter against the entry's, field by field.
export function verifyFrontmatter(text: string, e: SkillEntry): string | undefined {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!m) return `${e.uri} does not begin with frontmatter`;
  const r = yamlWithin(m[1]!, FRONTMATTER_MAX);
  if ("problem" in r) return `the frontmatter of ${e.uri}: ${r.problem}`;
  if (!isObject(r.value)) return `the frontmatter of ${e.uri} is not a map`;
  const got = r.value;
  for (const k of new Set([...Object.keys(got), ...Object.keys(e.frontmatter)])) {
    if (canon(got[k] ?? null) !== canon(e.frontmatter[k] ?? null)) return `the frontmatter field ${k} of ${e.uri} is not what its listing says`;
  }
}

// The body of a SKILL.md: what follows its frontmatter.
export const bodyOf = (text: string) => text.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "").trim();

// A supporting file a model names, as the URI of the manifest's file it means: a relative path resolved against the
// skill's folder, or a full URI. Only a URI the retained manifest names is a file of the skill.
export function fileIn(e: SkillEntry, path: string): SkillFile | undefined {
  const want = path.trim();
  if (!want) return undefined;
  const base = e.uri.slice(0, e.uri.lastIndexOf("/") + 1);
  const tries = new Set<string>([want]);
  if (!/^[a-z][a-z0-9+.-]*:/i.test(want)) {
    tries.add(base + want.replace(/^\.\//, ""));
    try { tries.add(new URL(want, e.uri).href); } catch {} // (no relative form for this scheme: the plain join stands)
  }
  for (const t of tries) {
    const hit = e.files.find((f) => f.uri === t);
    if (hit) return hit;
  }
}
