import { describe, expect, test } from "bun:test";
import { readPictures } from "./config.ts";
import { importsOf, kebabOf, marksOf, selectSpecs, specReach } from "./select.ts";

const config = (over: Record<string, unknown> = {}) => readPictures(JSON.stringify({
  run: "scripts/pictures.sh", pages: ["ui/"], specs: ["test/e2e/*.spec.ts"], sizes: ["1920x1040", "390x844"], themes: ["light", "dark"], global: ["test/e2e/chat.spec.ts"], ...over,
})).config!;

// A small page: an entry, a stylesheet, two components with marks, a hook with none, and specs.
const files: Record<string, string> = {
  "ui/src/main.tsx": `import "./styles.css";\nimport { App } from "./App.tsx";\nrender(<App />);`,
  "ui/src/styles.css": ":root { --accent: blue; }",
  "ui/src/App.tsx": `import { Board } from "./components/WorkBoard.tsx";\nimport { Menu } from "./components/Menu";\nexport const App = () => <div><Board /><Menu /></div>;`,
  "ui/src/components/WorkBoard.tsx": `import { useClock } from "../lib/clock.ts";\nexport const Board = () => <ul data-testid="work-board"><Fact testid="board-landed" /></ul>;`,
  "ui/src/components/Menu.tsx": `import { useClock } from "../lib/clock.ts";\nexport const Menu = () => <nav data-testid={"menu"} />;`,
  "ui/src/components/Hidden.tsx": `export const Hidden = () => <i data-testid={\`hidden-\${x}\`} />;`,
  "ui/src/lib/clock.ts": "export const useClock = () => 1;",
  "ui/src/lib/clock.test.ts": "test('x', () => {});",
  "test/e2e/work-board.spec.ts": `await page.getByTestId("work-board").click();\nawait shoot(page, "board-panel");`,
  "test/e2e/menu.spec.ts": `await page.locator('[data-testid="menu"]').click();\nawait shoot(page, "menu");`,
  "test/e2e/landing.spec.ts": `await expect(card.getByTestId("board-landed")).toBeVisible();\nawait shoot(page, "landing");`,
  "test/e2e/no-shots.spec.ts": `await page.getByTestId("work-board").click();`,
  "test/e2e/chat.spec.ts": `await page.getByTestId("composer").fill("x");\nawait shoot(page, "chat");`,
  "test/e2e/named.spec.ts": `await shoot(page, "work-board-phone");`,
};
const paths = Object.keys(files);
const pick = (changed: string[], over?: Record<string, unknown>) => selectSpecs({ changed, paths, text: (p) => files[p], config: config(over) });

describe("spec selection", () => {
  test("a component's own marks choose the specs that look for them and take pictures", () => {
    const s = pick(["ui/src/components/WorkBoard.tsx"]);
    expect(s.skip).toBeUndefined();
    // work-board.spec and landing.spec look for its marks; named.spec takes a picture named after it; no-shots takes
    // none. One covers the file: the spec named after it runs, the others are named.
    expect(s.specs.map((x) => x.path)).toEqual(["test/e2e/work-board.spec.ts"]);
    expect(s.over.sort()).toEqual(["test/e2e/landing.spec.ts", "test/e2e/named.spec.ts"]);
    expect(s.unmatched).toEqual([]);
    // A picture named after the component is a reach of its own.
    const named = pick(["ui/src/components/WorkBoard.tsx"], { specs: ["test/e2e/named.spec.ts"] });
    expect(named.specs).toEqual([{ path: "test/e2e/named.spec.ts", files: ["ui/src/components/WorkBoard.tsx"], how: ["name"] }]);
  });

  test("a hook with no marks reaches the components that import it", () => {
    const s = pick(["ui/src/lib/clock.ts"]);
    const reached = [...s.specs, ...s.over.map((path) => ({ path }))].map((x) => x.path);
    expect(reached).toContain("test/e2e/menu.spec.ts");
    expect(reached).toContain("test/e2e/work-board.spec.ts");
    expect(reached).not.toContain("test/e2e/chat.spec.ts");
    expect(s.specs).toHaveLength(1);
  });

  test("a stylesheet that only the entry imports reaches every page: the global specs", () => {
    const s = pick(["ui/src/styles.css"]);
    expect(s.specs).toEqual([{ path: "test/e2e/chat.spec.ts", files: ["ui/src/styles.css"], how: ["global"] }]);
  });

  test("only tests changed: no run, and why", () => {
    expect(pick(["ui/src/lib/clock.test.ts", "test/e2e/menu.spec.ts"]).skip).toBe("only tests changed");
    expect(pick(["test/e2e/menu.spec.ts"]).skip).toBe("only tests changed");
    expect(pick(["src/server/app.ts", "test/e2e/menu.spec.ts"]).skip).toBe("no file of the page changed");
  });

  test("as few specs as cover the change come first, and max_specs bounds the run", () => {
    const s = pick(["ui/src/components/WorkBoard.tsx", "ui/src/components/Menu.tsx"]);
    expect(s.specs).toHaveLength(2);
    const covered = new Set(s.specs.flatMap((x) => x.files));
    expect(covered).toEqual(new Set(["ui/src/components/WorkBoard.tsx", "ui/src/components/Menu.tsx"]));
    expect(s.over.length).toBe(2);
    const one = pick(["ui/src/components/WorkBoard.tsx", "ui/src/components/Menu.tsx"], { max_specs: 1 });
    expect(one.specs).toHaveLength(1);
    expect(one.over).toHaveLength(3);
  });

  test("a changed file no spec reaches is named", () => {
    const s = pick(["ui/src/components/Hidden.tsx"]);
    // Its only mark is made at run time: nothing it renders is known, nothing imports it, so it counts as global.
    expect(s.specs.map((x) => x.path)).toEqual(["test/e2e/chat.spec.ts"]);
    const none = pick(["ui/src/components/Hidden.tsx"], { global: [] });
    expect(none.specs).toEqual([]);
    expect(none.unmatched).toEqual(["ui/src/components/Hidden.tsx"]);
  });
});

describe("the parts", () => {
  test("imports resolve within the tree, with or without an extension", () => {
    const has = (p: string) => p in files;
    expect(importsOf("ui/src/App.tsx", files["ui/src/App.tsx"]!, has).sort()).toEqual(["ui/src/components/Menu.tsx", "ui/src/components/WorkBoard.tsx"]);
    expect(importsOf("ui/src/main.tsx", files["ui/src/main.tsx"]!, has).sort()).toEqual(["ui/src/App.tsx", "ui/src/styles.css"]);
    expect(importsOf("ui/src/a.ts", `import x from "react";\nimport y from "../../../out.ts";`, has)).toEqual([]);
  });
  test("marks, a spec's reach and names", () => {
    expect(marksOf(files["ui/src/components/WorkBoard.tsx"]!)).toEqual(["work-board", "board-landed"]);
    expect(marksOf(files["ui/src/components/Hidden.tsx"]!)).toEqual([]);
    expect([...specReach(files["test/e2e/menu.spec.ts"]!).marks]).toEqual(["menu"]);
    expect(specReach("await shoot(page, `board-${n}`)").shots).toEqual(["board-"]);
    expect(kebabOf("ui/src/components/WorkBoard.tsx")).toBe("work-board");
  });
  test("the file's problems", () => {
    expect(readPictures(JSON.stringify({ run: "x", pages: ["ui"], specs: ["a"], sizes: ["big"] })).problems).toEqual(["sizes: big is not WIDTHxHEIGHT"]);
    expect(readPictures(JSON.stringify({ run: "x", pages: ["ui"], specs: ["a"] })).config!.pages).toEqual(["ui/"]);
  });
});
