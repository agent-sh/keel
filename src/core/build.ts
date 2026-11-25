// Which build of Keel this process is, and what a build marks as urgent for
// the sessions that still carry an older build's tools and system prompt
// (src/engine/build-pin.ts).
import { createHash } from "node:crypto";
import { statSync } from "node:fs";

// A stand-in for another build, for the upgrade e2e (test/e2e/build-pin.spec.ts):
// KEEL_TEST_BUILD is JSON that names the build and changes what a new build
// would: a line added to the core block of the system prompt, a tool's
// description or input, a tool removed, and urgent marks.
export type TestBuild = {
  id?: string;
  core?: string;
  tools?: Record<string, { description?: string; input_schema?: Record<string, unknown>; remove?: boolean }>;
  urgent?: { tools?: Record<string, string>; blocks?: Record<string, string> };
};
export const testBuild: TestBuild | undefined = (() => {
  const raw = process.env.KEEL_TEST_BUILD;
  if (!raw) return undefined;
  try { return JSON.parse(raw) as TestBuild; } catch { throw new Error("KEEL_TEST_BUILD is not JSON"); }
})();

// Changes with every build: the program and its entry file, by size and time.
export function buildId(): string {
  if (testBuild?.id) return testBuild.id;
  const parts = [process.execPath, process.argv[1] ?? ""].map((p) => {
    try { const st = statSync(p); return `${p}:${st.size}:${st.mtimeMs}`; } catch { return p; }
  });
  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 12);
}

// A change a live session must not wait for. A session keeps the tools and
// system prompt it was last sent until its cache is cold (or the pin's age
// passes, build_pin.max_age_hours), so a reworded description or prompt block
// reaches it late by design. Two kinds of change need a mark: a safety
// instruction, and any change of what a tool does under an unchanged input
// schema (the session would keep the old description of the new behaviour;
// the compatibility check in src/tools/pin.ts reads schemas only). A removed
// tool or a changed input needs none. The build that makes such a change
// gives the tool (by its name) or the prompt block (by its name in the kept
// prompt: "core", "instruction files", a feature block's first words) a mark
// a mark, any new text: a tool on its own definition (`urgent` in
// src/tools/types.ts), a prompt block here, one entry a line. A session whose
// pinned copy carries another mark, or none, takes this build's tools and
// prompt at its next request, at the price of one cache write of its context.
// A tool's mark reaches only the sessions that used the tool (a safety change starts its mark
// with "!", which reaches every session; a prompt block's mark always does).
// Everything not marked waits. The marks live where the change is, so two
// branches that each mark a tool merge clean (one record here, edited by both
// at the same line, conflicted every time).
// A mark can be removed once the builds before it are no longer pinned anywhere.
export const URGENT: { tools: Record<string, string>; blocks: Record<string, string> } = {
  // (A tool's own mark is read from its definition: toolMarks.)
  tools: {
    ...testBuild?.urgent?.tools,
  },
  blocks: {
    // Where a secret's placeholder becomes its value: a shell command only; a file tool refuses one.
    Secrets: "placeholder-shell-only",
    ...testBuild?.urgent?.blocks,
  },
};

// The urgent marks of a build's tools by name: each tool's own, then this
// file's (a test build's stand-in marks).
export function toolMarks(tools: readonly { name: string; urgent?: string }[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of tools) if (t.urgent) out[t.name] = t.urgent;
  return { ...out, ...URGENT.tools };
}

// What this process was built from. scripts/build.ts stamps a binary with its
// git revision (with `-dirty` when the tree had changes), its target and the
// time of the build; run from the sources there is nothing to stamp.
declare const __KEEL_REVISION__: string | undefined;
declare const __KEEL_TARGET__: string | undefined;
declare const __KEEL_UI_BUILT__: number | undefined;

export function buildInfo(): { revision: string; target: string; built_ms: number | null } {
  return {
    revision: typeof __KEEL_REVISION__ === "string" ? __KEEL_REVISION__ : "source",
    target: typeof __KEEL_TARGET__ === "string" ? __KEEL_TARGET__ : `${process.platform}-${process.arch}`,
    built_ms: typeof __KEEL_UI_BUILT__ === "number" ? __KEEL_UI_BUILT__ : null,
  };
}

// One line for `keel --version`.
export function versionLine(api: string): string {
  const b = buildInfo();
  return `keel ${b.revision} (${b.target}, api ${api}${b.built_ms ? `, built ${new Date(b.built_ms).toISOString()}` : ""})`;
}
