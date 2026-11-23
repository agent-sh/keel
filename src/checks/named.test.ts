import { expect, test } from "bun:test";
import { checkStatus, firstFolder, stoppedByTimeout, matchAll, matchCommand, normDir, overlay, parseChecks, parseTrace, readChecks, startText, type Where } from "./named.ts";

const FILE = JSON.stringify({
  checks: {
    typecheck: "bunx tsc --noEmit -p .",
    unit: { run: "bun test", args: true },
    e2e: { run: "bunx playwright test", args: true, cache: false },
    web: { run: "npm test", dir: "./web/" },
    remote: { run: "scripts/remote-verify.sh", args: true, tree: { commit: "last" }, drop: ["--wait", "--out"] },
    specs: { run: "~/bin/validate.sh", args: true, dir: "*", tree: { folder: 1 } },
  },
  wait: ["waitfor --capacity"],
  env: ["VERIFY_MAX_RUNS"],
});
const named = parseChecks(FILE);
const TOP = "/r/repo";
const at = (cwd = TOP): Where => ({ cwd, home: "/h", rel: (d) => (d === TOP ? "." : d.startsWith(`${TOP}/`) ? normDir(d.slice(TOP.length + 1)) : undefined) });
const m = (c: string, cwd?: string) => matchCommand(c, named, at(cwd));

test("a checks file: a string or an object a check, with its defaults, its waits and its variables", () => {
  expect(named.problems).toEqual([]);
  expect(named.checks.map((c) => [c.name, c.run, c.args, c.dir, c.cache, c.tree.kind, c.drop.length])).toEqual([
    ["typecheck", "bunx tsc --noEmit -p .", false, ".", true, "work", 0],
    ["unit", "bun test", true, ".", true, "work", 0],
    ["e2e", "bunx playwright test", true, ".", false, "work", 0],
    ["web", "npm test", false, "web", true, "work", 0],
    ["remote", "scripts/remote-verify.sh", true, ".", true, "commit", 2],
    ["specs", "~/bin/validate.sh", true, "*", true, "folder", 0],
  ]);
  expect([named.wait, named.env]).toEqual([["waitfor --capacity"], ["VERIFY_MAX_RUNS"]]);
});

test("what is wrong in a file is said, and the rest is kept", () => {
  const got = parseChecks(JSON.stringify({ checks: { ok: "make", "bad name": "x", empty: "", out: { run: "x", dir: "../up" }, flag: { run: "x", args: "yes" }, t: { run: "x", tree: { commit: "last" } } }, wait: [1] }));
  expect(got.checks.map((c) => c.name)).toEqual(["ok"]);
  expect(got.problems).toHaveLength(6);
  expect(parseChecks("{").problems[0]).toStartWith("it is not JSON");
});

test("the owner's setting is laid over the file: by name, null removes, its waits add", () => {
  const own = readChecks({ checks: { unit: { run: "bun test --bail", args: true }, web: null, lint: "make lint" }, wait: ["flock /x"] });
  const got = overlay(named, own)!;
  expect(got.checks.map((c) => `${c.name}:${c.run}`)).toEqual(["typecheck:bunx tsc --noEmit -p .", "e2e:bunx playwright test", "remote:scripts/remote-verify.sh", "specs:~/bin/validate.sh", "unit:bun test --bail", "lint:make lint"]);
  expect(got.wait).toEqual(["waitfor --capacity", "flock /x"]);
  expect(overlay(undefined, own)!.checks.map((c) => c.name)).toEqual(["unit", "lint"]);
});

test("a check as written, with its output shaped, filtered and read after", () => {
  expect(m("bunx tsc --noEmit -p .")).toMatchObject({ check: { name: "typecheck" }, alone: true, filters: 0, exact: true });
  expect(m("  bunx   tsc --noEmit -p . 2>&1 | tail -20")).toMatchObject({ command: "bunx tsc --noEmit -p .", filters: 1, alone: true });
  expect(m("bunx tsc --noEmit -p . > /tmp/x/tsc.log 2>&1; tail -5 /tmp/x/tsc.log; echo rc=$?")).toMatchObject({ check: { name: "typecheck" }, alone: false });
  expect(m("bun test ./src/checks")).toMatchObject({ command: "bun test ./src/checks", check: { name: "unit" } });
  expect(m("bunx tsc --noEmit -p . --watch")).toBeUndefined();
  expect(m("bun testing")).toBeUndefined();
  expect(m("bun test < /dev/null")?.check.name).toBe("unit");
});

test("a check behind a wait, a cd, assignments and a mkdir; its variables put in", () => {
  const c = "cd /r/repo && S=/h/scratch/lane && mkdir -p $S && waitfor --capacity 26,8 --timeout 40m && bun test ./src/checks > $S/unit.log 2>&1; tail -3 $S/unit.log";
  expect(m(c, "/elsewhere")).toMatchObject({ check: { name: "unit" }, command: "bun test ./src/checks", dir: ".", alone: false, start: "bun test ./src/checks" });
  expect(m("(waitfor --capacity 20,8 --timeout 10m && bunx tsc --noEmit -p .) > /dev/null 2>&1; echo done")?.check.name).toBe("typecheck");
  expect(m("S=/a && bun test $S/x")).toMatchObject({ exact: true, command: "bun test /a/x", answers: true });
  // A wait the repository does not name still changes nothing: recorded, never answered.
  expect(m("sleep 5 && bun test")).toMatchObject({ treeAt: "start", answers: false });
});

test("a check whose words the ledger cannot know is not counted", () => {
  // A `$` the command does not set, the shell's own, a default, a substitution, an exported value of that kind.
  for (const c of ["bun test $DIR", "bun test ${X:-a}", "bun test $1", "bun test $(cat list)", "bun test `x`", "bun test <(ls)", "X=$OTHER bun test", "export MODE=$OTHER && bun test", "S=$(pwd) && bun test $S"]) {
    expect([c, m(c)]).toEqual([c, undefined]);
  }
  // Its input from a file, a pipe or a here-document, or the check in the background.
  for (const c of ["bun test < in", "ls | bun test", "bun test <<EOF\nx\nEOF", "bun test <<< x", "bun test &", "(bun test) & echo started", "bun test | xargs echo"]) {
    expect([c, m(c)]).toEqual([c, undefined]);
  }
  // (A `$` in single quotes, or at a word's end, is a `$`.)
  expect(m("bun test -t 'a$b'")?.command).toBe("bun test -t a$b");
});

test("a run behind and before other commands: recorded on the tree it ran on, answered only in the narrow form", () => {
  // Nothing before it changes a file: the tree as the command starts.
  expect(m("bun test; rm -rf x")).toMatchObject({ treeAt: "start", answers: false });
  expect(m("bun test || true")).toMatchObject({ treeAt: "start", answers: false });
  expect(m("ls src; git log --oneline -3; bun test")).toMatchObject({ treeAt: "start", answers: false });
  expect(m("cat <<EOF\nx\nEOF\nbun test")).toMatchObject({ treeAt: "start", answers: false });
  // Something before it may: the tree as it ended, when nothing from the check on changes one.
  expect(m("rm -rf x && bun test")).toMatchObject({ treeAt: "end", answers: false });
  expect(m("sed -i s/a/b/ src/x.ts && bunx tsc --noEmit -p . 2>&1 | tail -3; echo rc=$?")).toMatchObject({ treeAt: "end" });
  expect(m("python3 - <<'EOF'\nopen('a','w').write('bun test')\nEOF\nbun test ./src | tail -5")).toMatchObject({ treeAt: "end", command: "bun test ./src" });
  // Neither: an edit before it and one after it, or a job before it still at work in the background.
  expect(m("make && bun test; git checkout -- x")).toBeUndefined();
  expect(m("make & bun test")).toBeUndefined();
  // A reader's output into the repository may be what a check reads.
  expect(m("echo x > src/gen.ts; bun test")).toMatchObject({ treeAt: "end" });
  expect(m("echo x > /h/out.log; bun test")).toMatchObject({ treeAt: "start" });
  // The reading stops where it cannot follow the shell.
  expect(m("source env.sh && bun test")).toBeUndefined();
  expect(m("if true; then bun test; fi")).toBeUndefined();
  expect(m("bun test 'open")).toBeUndefined();
});

test("a check through a launcher or a filter, and its output into a file", () => {
  expect(m("timeout 300 bunx tsc --noEmit -p . 2>&1 | tail")).toMatchObject({ check: { name: "typecheck" }, command: "bunx tsc --noEmit -p .", timeout: true, filters: 1, start: "timeout 300 bunx tsc --noEmit -p .", answers: true });
  expect(m("timeout -k 10 15m bun test ./x")).toMatchObject({ command: "bun test ./x", timeout: true });
  expect(m("nice -n 10 bun test ./x")).toMatchObject({ command: "bun test ./x", start: "nice -n 10 bun test ./x" });
  expect(m("nice bun test")?.timeout).toBeUndefined();
  expect(m("ionice -c 3 nice -n 5 bun test")?.command).toBe("bun test");
  // (`timeout` with a word that is not a time is something else.)
  expect(m("timeout bun test")).toBeUndefined();
  expect(m("bun test 2>&1 | grep -E 'pass|fail' | head -5")).toMatchObject({ filters: 2, answers: true });
  expect(m("bun test |& tee /h/u.log | tail -3")).toMatchObject({ filters: 2 });
  expect(m("bun test | sed -n 1,5p")?.filters).toBe(1);
  expect(m("bun test | sed -i x f")).toBeUndefined();
  // A filter that writes into the repository: the tree as it ended is not what the check read.
  expect(m("rm x; bun test | tee out.log")).toBeUndefined();
});

test("a leading assignment and a cd into the repository, from a folder outside it", () => {
  expect(m("cd /r/repo && KEEL_X=1 VERIFY_MAX_RUNS=8 scripts/remote-verify.sh --host box --wait 1500 --only e2e abc123", "/elsewhere")).toMatchObject({ check: { name: "remote" }, command: "KEEL_X=1 scripts/remote-verify.sh --host box --only e2e", tree: { kind: "commit", rev: "abc123" }, answers: true });
  expect(m("W=~/scratch && cd /r/repo && bun test > $W/u.log 2>&1; tail -3 $W/u.log", "/elsewhere")).toMatchObject({ treeAt: "start", answers: true, command: "bun test" });
  expect(firstFolder("cd ~/w && cd sub; bun test", "/x", "/h")).toBe("/h/w/sub");
  expect(firstFolder("bun test", "/x", "/h")).toBe("/x");
  // A cd inside a group does not outlast it.
  expect(m("(cd web && ls); npm test")).toBeUndefined();
  expect(m("(cd web && ls); npm test", `${TOP}/web`)?.check.name).toBe("web");
});

test("every check a command runs, each on its tree", () => {
  const all = matchAll("cd /r/repo && bunx tsc --noEmit -p . | tail -3; bun test src/x 2>&1 | grep -E 'pass|fail'; git log --oneline -1", named, at("/elsewhere"));
  // (A check is not still for the one after it: it may write a snapshot, a cache, what it found.)
  expect(all.map((x) => [x.check.name, x.treeAt, x.answers])).toEqual([["typecheck", "start", false], ["unit", "end", false]]);
  expect(matchAll("git rebase origin/main && bunx tsc --noEmit -p . && bun test", named, at()).map((x) => [x.check.name, x.treeAt])).toEqual([["unit", "end"]]);
});

test("a check runs in its own folder; a cd moves there", () => {
  expect(m("npm test")).toBeUndefined();
  expect(m("npm test", `${TOP}/web`)?.check.name).toBe("web");
  expect(m("cd web && npm test")).toMatchObject({ dir: "web", check: { name: "web" } });
  expect(m("cd .. && bun test", `${TOP}/web`)?.dir).toBe(".");
  expect(m("cd /elsewhere && bun test")).toBeUndefined();
  expect(normDir("a/./b/../c/")).toBe("a/c");
});

test("a check of a commit: its last argument names one unless it is an option's value; dropped options are not part of what it is known by", () => {
  // The candidate is resolved by the caller (src/checks/runs.ts): the run is known without it when it is a commit, with it (`named`) when not.
  expect(m("VERIFY_MAX_RUNS=4 scripts/remote-verify.sh --host box --wait 1500 --only unit --out /h/o keel/my-branch")).toMatchObject({ command: "scripts/remote-verify.sh --host box --only unit", tree: { kind: "commit", rev: "keel/my-branch", named: "scripts/remote-verify.sh --host box --only unit keel/my-branch" } });
  expect(m("scripts/remote-verify.sh --only unit")?.tree).toEqual({ kind: "commit" });
  expect(m("scripts/remote-verify.sh")?.tree).toEqual({ kind: "commit" });
  // Another variable on it is part of it.
  expect(m("X=1 scripts/remote-verify.sh")?.command).toBe("X=1 scripts/remote-verify.sh");
});

test("a check that runs anywhere is known by the folder it ran in; ~ and $PWD put in", () => {
  expect(m("~/bin/validate.sh $PWD test/e2e/a.spec.ts", "/r/wt")).toMatchObject({ check: { name: "specs" }, dir: "/r/wt", command: "/h/bin/validate.sh test/e2e/a.spec.ts", tree: { kind: "folder", folder: "/r/wt" } });
  expect(m("/h/bin/validate.sh /r/wt x.spec.ts", `${TOP}/packages/a`)?.dir).toBe("packages/a");
  expect(m("/h/bin/validate.sh /r/wt x.spec.ts", `${TOP}/packages/b`)?.dir).toBe("packages/b");
  expect(m("cd /r/wt && /h/bin/validate.sh . test/e2e/a.spec.ts")?.tree).toEqual({ kind: "folder", folder: "/r/wt" });
  expect(m("$HOME/bin/validate.sh /r/wt2 x.spec.ts")?.tree).toEqual({ kind: "folder", folder: "/r/wt2" });
});

test("what the command exports is part of what the check run is known by", () => {
  expect(m("export CHECK_MODE=strict && bun test")).toMatchObject({ command: "CHECK_MODE=strict bun test", exact: true });
  expect(m("CHECK_MODE=strict; export CHECK_MODE; bun test")?.command).toBe("CHECK_MODE=strict bun test");
  expect(m("set -a; MODE=x; bun test")?.command).toBe("MODE=x bun test");
  // A plain assignment the check does not see is not; a value not known here is never answered.
  expect(m("S=/x && bun test")?.command).toBe("bun test");
  expect(m("export MODE=$OTHER && bun test")).toBeUndefined();
  // A variable the repository says changes no result is left out.
  expect(m("export VERIFY_MAX_RUNS=4 && bun test")?.command).toBe("bun test");
});

test("where the command leaves the shell: its cds outside a group", () => {
  expect(m("cd web && npm test")?.shellCwd).toBe(`${TOP}/web`);
  expect(m("(cd web && npm test)")?.shellCwd).toBe(TOP);
  expect(m("bun test", `${TOP}/web`)).toBeUndefined();
  expect(m("cd .. && bun test", `${TOP}/web`)?.shellCwd).toBe(TOP);
});

test("a check's inputs: paths from the repository's top", () => {
  expect(parseChecks(JSON.stringify({ checks: { t: { run: "x", inputs: ["node_modules", "node_modules/../bun.lock"] } } })).checks[0]!.inputs).toEqual(["node_modules", "node_modules/../bun.lock"]);
  expect(parseChecks(JSON.stringify({ checks: { t: { run: "x", inputs: ["/etc/passwd"] } } })).problems).toHaveLength(1);
});

test("the shell's report: a check that never started has no status; one that did has its own", () => {
  const trace = (rows: string[][]) => parseTrace(rows.map((r) => r.join("\t")).join("\n"));
  // A wait that gave up: the check's line is not there.
  expect(checkStatus(trace([["D", "1", "0", "0", "waitfor --capacity 26,8"], ["D", "1", "0", "1", "waitfor --capacity 26,8"], ["E", "1"]]), "bun test", 0)).toBeUndefined();
  // Piped into tail: the status of the pipe at the next command of its shell, the check's first.
  expect(checkStatus(trace([["D", "1", "0", "0", "bun test ./x 2>&1"], ["D", "1", "0", "0", "tail -3"], ["D", "1", "0", "4 0", "echo after"], ["E", "0"]]), "bun test ./x", 1)).toEqual({ exit: 4 });
  // Last in a group: the group's status at the next command of the shell around it.
  expect(checkStatus(trace([["D", "1", "0", "0", "S=/x"], ["D", "2", "1", "0", "waitfor --capacity 1,1"], ["D", "2", "1", "0", "bun test > /x/log 2>&1"], ["D", "1", "0", "3", "tail -1 /x/log"], ["E", "0"]]), "bun test", 0)).toEqual({ exit: 3 });
  // Last of all: the end's statuses.
  expect(checkStatus(trace([["D", "1", "0", "0", "bun test"], ["E", "0"]]), "bun test", 0)).toEqual({ exit: 0 });
  // Started and stopped before any status: none known.
  expect(checkStatus(trace([["D", "1", "0", "0", "bun test"]]), "bun test", 0)).toEqual({ exit: null });
  expect(startText("A=1 bun test ./x > log 2>&1")).toBe("bun test ./x");
  // The same words twice: each run has its own report.
  const twice = trace([["D", "1", "0", "0", "bun test"], ["D", "1", "0", "0", "bun test"], ["D", "1", "0", "1", "echo x"], ["E", "0"]]);
  expect([checkStatus(twice, "bun test", 0), checkStatus(twice, "bun test", 0, 1)]).toEqual([{ exit: 0 }, { exit: 1 }]);
  expect(matchAll("bun test; bun test", named, at()).map((x) => x.nth)).toEqual([undefined, 1]);
  // Under `timeout`: its own statuses for a stop, the check's for the rest.
  expect([124, 125, 137, 1, 0, 127].map(stoppedByTimeout)).toEqual([true, true, true, false, false, false]);
});

test("a check's status inside a group or past a shell it started is its own, or not known", () => {
  const trace = (rows: string[][]) => parseTrace(rows.map((r) => r.join("\t")).join("\n"));
  // `(chk | tail -1) && echo z`: the group's status is its last filter's, not the check's.
  expect(checkStatus(trace([["D", "2", "1", "0", "bun test"], ["D", "2", "1", "0", "tail -1"], ["D", "1", "0", "0", "echo z"], ["E", "0"]]), "bun test", 1)).toEqual({ exit: null });
  expect(checkStatus(trace([["D", "2", "1", "0", "bun test"], ["D", "2", "1", "0", "tail -1"], ["E", "0"]]), "bun test", 1)).toEqual({ exit: null });
  // `chk; (true)` and `(chk); (true)`: the next shell's first line holds the check's status, not the end's.
  expect(checkStatus(trace([["D", "1", "0", "0", "bun test"], ["D", "3", "1", "1", "true"], ["E", "0"]]), "bun test", 0)).toEqual({ exit: 1 });
  expect(checkStatus(trace([["D", "2", "1", "0", "bun test"], ["D", "3", "1", "1", "true"], ["E", "0"]]), "bun test", 0)).toEqual({ exit: 1 });
  // (Unless a job in the background may have printed it.)
  expect(checkStatus(trace([["D", "1", "0", "0", "bun test"], ["D", "3", "1", "0", "true"], ["E", "0"]]), "bun test", 0, 0, true)).toEqual({ exit: null });
  // A report at its cap: the end's statuses are of what ran last, not the check's.
  const full = [...Array.from({ length: 199 }, () => ["D", "1", "0", "0", "true"]), ["D", "1", "0", "0", "bun test"], ["E", "0"]];
  expect(checkStatus(trace(full), "bun test", 0)).toEqual({ exit: null });
  // Its pipe stays in its group: a group piped into a filter is not a run as named.
  for (const c of ["( (bun test) | tail -1 ); echo", "(bun test) | tail -2", "{ bun test; } | tail -2", "(bun test) 2>&1 | tail -2", "bun test | (cat)", "bun test | tee >(cat) | tail -1"]) expect([c, m(c)]).toEqual([c, undefined]);
  expect(matchAll("sleep 9 & bun test; (true)", named, at())[0]?.bg).toBe(true);
});

test("an assignment to a variable of the shell's environment is exported", () => {
  const env = (c: string) => matchCommand(c, named, { ...at(), environ: (n) => n === "PATH" || n === "NODE_ENV" });
  expect(env("PATH=/opt/other/bin; bun test")?.command).toBe("PATH=/opt/other/bin bun test");
  expect(env("NODE_ENV=production; bun test")?.command).toBe("NODE_ENV=production bun test");
  // (Its value not known here: not counted.)
  expect(env("PATH=/x:$PATH; bun test")).toBeUndefined();
  expect(env("S=/x; bun test")?.command).toBe("bun test");
  // What a `( )` group sets ends with it.
  expect(m("(X=1); bun test $X")).toBeUndefined();
  expect(m("(export MODE=x); bun test")?.command).toBe("bun test");
  expect(m("(cd web); (npm test)", `${TOP}/web`)?.check.name).toBe("web");
  expect(m("(cd web); (npm test)")).toBeUndefined();
});

test("commands that write while they seem to read, and what an answer would drop", () => {
  // Each moves the tree: the check is not on the tree the command started with.
  for (const c of ["sort -o src/a.ts src/a.ts && bun test", "sort --output=src/a.ts x && bun test", "uniq src/a.txt src/b.txt; bun test", "sed -n 'w src/a.ts' src/b.ts && bun test", "sed 's/a/b/w out' x; bun test", "sed '1e touch x' f; bun test",
    "waitfor --until 'git checkout other -- .' && bun test", "waitfor --capacity 20,8 --until 'git stash' && bun test", "> src/a.ts; bun test", "X=1 > src/a.ts; bun test", "git -c core.fsmonitor=x status && bun test"]) {
    expect([c, m(c)?.treeAt]).toEqual([c, "end"]);
  }
  for (const c of ["sort -u x; bun test", "uniq -c x; bun test", "sed -n '1,5p;/x/{p;q}' f; bun test", "sed -e 's/w/e/g' f; bun test", "waitfor --capacity 20,8 --timeout 10m && bun test"]) {
    expect([c, m(c)?.treeAt]).toEqual([c, "start"]);
  }
  // A check before another may have written what the other reads: the other is on the tree as the command ended.
  expect(matchAll("bun test --update-snapshots && bunx tsc --noEmit -p .", named, at()).map((x) => [x.check.name, x.treeAt])).toEqual([["unit", "start"], ["typecheck", "end"]]);
  // A shell function by a check's name, a here-document whose body runs a command: not read past.
  expect(m("bun() { :; }; bun test")).toBeUndefined();
  expect(m("cat <<EOF >/dev/null\n$(git checkout other -- .)\nEOF\nbun test")).toBeUndefined();
  expect(m("cat <<'EOF' >/dev/null\n$(not run)\nEOF\nbun test")).toMatchObject({ treeAt: "start" });
  // A cd that may not run, or runs in the background: the folder after it is not known.
  for (const c of ["[ -d web ] && cd web; npm test", "false || cd web && npm test", "cd web & npm test"]) expect([c, m(c)]).toEqual([c, undefined]);
  expect(m("mkdir -p web && cd web && npm test")?.check.name).toBe("web");
  // An answer would not write what the commands after the check write.
  expect(m("bun test; echo x > /h/out.txt")).toMatchObject({ treeAt: "start", answers: false });
  expect(m("bun test; tail -3 log | tee /h/t.txt")?.answers).toBe(false);
  expect(m("bun test > /h/u.log 2>&1; tail -3 /h/u.log")?.answers).toBe(true);
});

test("a shell that reports no process (bash 3 has no $BASHPID): the check's status is not known", () => {
  const trace = (rows: string[][]) => parseTrace(rows.map((r) => r.join("\t")).join("\n"));
  // `cat <(slow); bun test; true` with the check failing: the substitution's late line (its stale status)
  // looks like the check's own shell when no line names its process.
  expect(checkStatus(trace([["D", "", "0", "0", "bun test"], ["D", "", "1", "0", "echo"], ["D", "", "0", "1", "true"], ["E", "0"]]), "bun test", 0)).toEqual({ exit: null });
  expect(checkStatus(trace([["D", "", "0", "0", "bun test"], ["E", "1"]]), "bun test", 0)).toEqual({ exit: null });
});
