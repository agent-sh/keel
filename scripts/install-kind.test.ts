import { expect, test } from "bun:test";
import { installKind, type Facts } from "./install-kind.ts";

const R = "a".repeat(40);
const C = "c".repeat(40);
const binary = ["package.json", "src/main.ts", "src/engine/turn.ts", "ui/src/lib/tools.ts", "test/fixtures/plugin-v1/expected.json"];
const build = ["scripts/build.ts", "scripts/page-graph.ts", "src/core/api-stamp.ts"];
type Over = Omit<Partial<Facts>, "engine" | "built"> & { changed: string[] | null; engine?: Partial<Facts["engine"]>; built?: Partial<Facts["built"]> };
const facts = ({ engine, built, ...over }: Over): Facts => ({
  target: C,
  served: { page: "page1", revision: R },
  engineLater: false,
  pageLater: false,
  ...over,
  engine: { revision: R, api: "api1", bun: "1.3.0", ...engine },
  built: { api: "api1", page: "page1", binary, build, bun: "1.3.0", ...built },
});
const kind = (f: Facts) => installKind(f).kind;

test("docs, tests and files the binary never imports install nothing", () => {
  const r = installKind(facts({ changed: ["README.md", "docs/landing.md", "src/ui-conventions.test.ts", "test/e2e/chat.spec.ts", "src/core/stand.ts", ".keel/land-install.sh", "LICENSE"] }));
  expect(r.kind).toBe("none");
  expect(r.why).toContain("nothing installed");
});

test("a page change, with a test beside it, installs the page alone", () => {
  const r = installKind(facts({ changed: ["ui/src/App.tsx", "src/ui-conventions.test.ts"], built: { api: "api1", page: "page2", binary, build } }));
  expect(r.kind).toBe("page");
  expect(r.why).toContain("no restart");
});

test("a page the daemon does not describe is installed again, not the engine", () => {
  expect(kind(facts({ changed: ["ui/src/App.tsx"], served: { page: null, revision: null } }))).toBe("page");
});

test("a file the binary is compiled from is the engine, wherever it lives", () => {
  expect(kind(facts({ changed: ["src/engine/turn.ts"] }))).toBe("engine");
  expect(kind(facts({ changed: ["ui/src/lib/tools.ts"] }))).toBe("engine");
  expect(kind(facts({ changed: ["test/fixtures/plugin-v1/expected.json"] }))).toBe("engine");
});

test("the build's own files and the toolchain's at the root are the engine", () => {
  expect(kind(facts({ changed: ["scripts/build.ts"] }))).toBe("engine");
  expect(kind(facts({ changed: ["bun.lock"] }))).toBe("engine");
  expect(kind(facts({ changed: ["tsconfig.json", "README.md"] }))).toBe("engine");
});

test("what cannot be compared is the engine", () => {
  expect(kind(facts({ changed: null }))).toBe("engine");
  expect(kind(facts({ changed: ["README.md"], engine: { revision: `${R}-dirty`, api: "api1" } }))).toBe("engine");
  expect(kind(facts({ changed: ["README.md"], engine: { revision: null, api: null } }))).toBe("engine");
  // No file of the graph changed, but the stamps differ (the daemon was built another way): the engine.
  expect(kind(facts({ changed: ["README.md"], engine: { revision: R, api: "old" } }))).toBe("engine");
});

test("a later engine or page is never replaced by an earlier commit", () => {
  expect(kind(facts({ changed: ["src/engine/turn.ts"], engineLater: true }))).toBe("none");
  expect(kind(facts({ changed: ["ui/src/App.tsx"], built: { api: "api1", page: "page2", binary, build }, pageLater: true, served: { page: "page3", revision: "b".repeat(40) } }))).toBe("none");
});

test("the daemon already at the commit, with its page, installs nothing", () => {
  expect(kind(facts({ changed: [], engine: { revision: C, api: "api1" } }))).toBe("none");
});

test("a binary built with another Bun is the engine, even when no file changed", () => {
  expect(kind(facts({ changed: ["README.md"], built: { bun: "1.3.1" } }))).toBe("engine");
  expect(kind(facts({ changed: ["ui/src/App.tsx"], built: { page: "page2", bun: "1.3.1" } }))).toBe("engine");
  expect(kind(facts({ changed: [], target: R, built: { bun: null } }))).toBe("engine");
  expect(kind(facts({ changed: ["README.md"], engine: { bun: null } }))).toBe("engine");
  // A daemon already past the commit is left alone whatever it runs on.
  expect(kind(facts({ changed: ["README.md"], engineLater: true, built: { bun: "1.3.1" } }))).toBe("none");
});
