// What a command does that a restore of files leaves alone, read from its words (src/safety/not-undone.ts).
import { expect, test } from "bun:test";
import { shellReach } from "./not-undone.ts";

const W = "/w/repo", HOME = "/home/u";
const reach = (command: string) => shellReach(command, W, { workspace: W, own: [W, "/scratch"], home: HOME, scratch: ["/scratch"] });
const kinds = (command: string) => reach(command).out.map((r) => r.kind);

test("git that changes refs, the stash or a remote is named, and git that reads is not", () => {
  expect(kinds("git commit -m x")).toEqual(["git"]);
  expect(kinds("git -C sub -c user.name=a commit -qm x")).toEqual(["git"]);
  expect(kinds("git add -A && git commit -m x && git push origin main")).toEqual(["git", "remote"]);
  expect(kinds("git push --dry-run origin main")).toEqual([]);
  expect(reach("git push /srv/a/long/path/to/remote.git HEAD:main").out).toEqual([{ kind: "remote", line: "git push …/remote.git HEAD:main" }]);
  expect(kinds("git tag v1")).toEqual(["git"]);
  expect(kinds("git tag -l")).toEqual([]);
  expect(kinds("git branch -D old")).toEqual(["git"]);
  expect(kinds("git branch")).toEqual([]);
  expect(kinds("git stash list")).toEqual([]);
  expect(kinds("git status && git log -3 && git diff")).toEqual([]);
});

test("a request names its host only when it sends something", () => {
  expect(reach("curl -X POST -d a=1 https://api.example.com/v1/x").out).toEqual([{ kind: "remote", line: "sent a request to api.example.com" }]);
  expect(kinds("curl -s https://example.com/page")).toEqual([]);
  expect(kinds("curl -X POST -d a=1 http://localhost:3000/x")).toEqual([]);
  expect(kinds("wget --post-data=a=1 https://example.org/f")).toEqual(["remote"]);
});

test("paths outside the folder are named, paths inside are candidates, a scratch folder is its own", () => {
  const r = reach("echo x > /home/u/notes/x && rm -rf data && cp a.txt /scratch/a.txt && echo y | tee src/new.ts");
  expect(r.out).toEqual([{ kind: "outside", line: "wrote ~/notes/x" }]);
  expect(r.touched).toEqual([{ path: "data", how: "deleted" }, { path: "src/new.ts", how: "wrote" }]);
  expect(reach("cd /tmp/other && rm -f x").out).toEqual([{ kind: "outside", line: "deleted /tmp/other/x" }]);
  expect(reach("echo hi > /dev/null").out).toEqual([]);
  expect(reach("rm -rf $dir").touched).toEqual([]);
});
