import { expect, test } from "bun:test";
import { highRisk, isReadOnly, matchRule, splitCommand, suggestRule } from "./shell.ts";

const split = (c: string) => splitCommand(c)!;
const ro = (c: string) => split(c).every(isReadOnly);

test("splits on operators and finds commands inside substitutions", () => {
  expect(split("git status && npm test | tee out; echo done").map((s) => s.words[0])).toEqual(["git", "npm", "tee", "echo"]);
  expect(split('echo "$(rm -rf x)"').map((s) => s.words[0])).toEqual(["rm", "echo"]);
  expect(split("ls `whoami`").map((s) => s.words[0])).toEqual(["whoami", "ls"]);
  expect(split("for f in a b; do cat $f; done").map((s) => s.words[0])).toEqual(["cat"]);
  expect(split("echo 'a && b'")).toHaveLength(1);
  expect(splitCommand("echo 'open")).toBeNull();
});

test("read-only commands", () => {
  for (const c of ["ls -la", "git status", "git -C sub log --oneline -5", "rg foo src | head -20", "cat a 2>/dev/null", "sed -n 1,20p f", "find . -name '*.ts'"])
    expect(ro(c)).toBe(true);
  for (const c of ["rm x", "echo hi > f", "git commit -m x", "find . -delete", "git -c core.pager=x log", "sed -i s/a/b/ f", "FOO=1 ls", "env rm x", "git diff --output=x", "npm test"])
    expect(ro(c)).toBe(false);
});

test("high risk keeps its reason", () => {
  expect(highRisk(split("git push --force origin main")[0]!)).toContain("history");
  expect(highRisk(split("rm -rf ~")[0]!)).toContain("recursively");
  expect(highRisk(split("rm -rf build")[0]!)).toBeNull();
  expect(highRisk(split("git reset --hard HEAD~1")[0]!)).toBe("discards uncommitted work");
  expect(highRisk(split("git push origin main")[0]!)).toBeNull();
});

test("rules match like Claude Code's", () => {
  const s = (c: string) => split(c)[0]!;
  expect(matchRule("git log *", s("git log"))).toBe(true);
  expect(matchRule("git log *", s("git log --oneline main"))).toBe(true);
  expect(matchRule("git log *", s("git logx"))).toBe(false);
  expect(matchRule("npm test", s("npm test"))).toBe(true);
  expect(matchRule("npm test", s("npm test --watch"))).toBe(false);
  expect(matchRule("npm:*", s("npm run x"))).toBe(true);
  expect(matchRule("git * main", s("git push origin main"))).toBe(true);
  expect(suggestRule(s("bun test src/x.test.ts"))).toBe("bun test *");
  expect(suggestRule(s("./run.sh --fast"))).toBe("./run.sh *");
});
