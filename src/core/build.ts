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
// here, any new text. A session whose pinned copy carries another mark, or
// none, takes this build's tools and prompt at its next request, at the price
// of one cache write of its context. Everything not marked waits.
// A mark can be removed once the builds before it are no longer pinned anywhere.
export const URGENT: { tools: Record<string, string>; blocks: Record<string, string> } = {
  // An agent may start agents of its own, and message the other agents of its tree.
  tools: { Agent: "nested-agents", spawn_agent: "nested-agents", SendMessage: "agent-tree-messages", send_input: "agent-tree-messages", ...testBuild?.urgent?.tools },
  blocks: { ...testBuild?.urgent?.blocks },
};

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
