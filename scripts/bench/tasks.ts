// The token benchmark's fixed tasks: small scratch repos with a real shape
// (several modules, tests, a README) and a check that decides success from the
// repo and the final reply, never from how the model got there.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { TICKETS } from "./tracker-mcp.ts";

export type Check = { ok: boolean; why: string };
export type Task = {
  id: string;
  kind: string;
  prompt: string;
  files: Record<string, string>;
  check: (dir: string, reply: string) => Check;
  // MCP servers the task needs (the bench configures them only when such a task runs).
  mcp?: Record<string, { command: string; args: string[] }>;
};

const run = (dir: string, cmd: string[]) => {
  const p = Bun.spawnSync(cmd, { cwd: dir, stdout: "pipe", stderr: "pipe", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
  return { code: p.exitCode, out: `${p.stdout}${p.stderr}` };
};
const pyTests = (dir: string) => run(dir, ["python3", "-m", "unittest", "discover", "-s", "tests", "-t", "."]);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const walk = (dir: string, ext: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    if (n.startsWith(".")) return [];
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p, ext) : p.endsWith(ext) ? [p] : [];
  });

// Shared filler that makes a repo look like one: the model has to find the
// part that matters among modules that do not.
const pyUtil = `"""Small helpers shared by the modules."""
from __future__ import annotations

import re
from typing import Iterable, Iterator, TypeVar

T = TypeVar("T")


def chunked(items: Iterable[T], size: int) -> Iterator[list[T]]:
    """Yield lists of at most size items."""
    if size <= 0:
        raise ValueError("size must be positive")
    buf: list[T] = []
    for it in items:
        buf.append(it)
        if len(buf) == size:
            yield buf
            buf = []
    if buf:
        yield buf


def slug(text: str) -> str:
    """Lowercase words joined by dashes."""
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


def money(cents: int) -> str:
    sign = "-" if cents < 0 else ""
    cents = abs(cents)
    return f"{sign}{cents // 100}.{cents % 100:02d}"
`;

const explain: Task = {
  id: "explain",
  kind: "read code",
  prompt:
    "In this repo, what order quantity starts the bulk discount and how many percent off is it? " +
    "Reply with one line exactly like: threshold=<n> percent=<p>",
  files: {
    "README.md": "# shop\n\nOrder pricing for a small shop: catalog, inventory, pricing rules and a CLI.\n\nRun `python3 -m shop.cli price SKU QTY`.\n",
    "shop/__init__.py": "",
    "shop/util.py": pyUtil,
    "shop/catalog.py": `"""The product catalog."""
from dataclasses import dataclass


@dataclass(frozen=True)
class Product:
    sku: str
    name: str
    cents: int
    weight_g: int


CATALOG = {
    "TEA-01": Product("TEA-01", "Green tea", 650, 120),
    "TEA-02": Product("TEA-02", "Black tea", 590, 120),
    "MUG-01": Product("MUG-01", "Mug", 1200, 380),
    "POT-01": Product("POT-01", "Teapot", 3400, 900),
}


def find(sku: str) -> Product:
    try:
        return CATALOG[sku]
    except KeyError:
        raise KeyError(f"unknown sku {sku}") from None
`,
    "shop/inventory.py": `"""Stock levels, reserved and free."""
from collections import defaultdict


class Inventory:
    def __init__(self) -> None:
        self.stock: dict[str, int] = defaultdict(int)
        self.reserved: dict[str, int] = defaultdict(int)

    def add(self, sku: str, n: int) -> None:
        self.stock[sku] += n

    def free(self, sku: str) -> int:
        return self.stock[sku] - self.reserved[sku]

    def reserve(self, sku: str, n: int) -> bool:
        if self.free(sku) < n:
            return False
        self.reserved[sku] += n
        return True

    def release(self, sku: str, n: int) -> None:
        self.reserved[sku] = max(0, self.reserved[sku] - n)
`,
    "shop/rules.py": `"""Discount rules. Percentages are whole numbers."""
from dataclasses import dataclass


@dataclass(frozen=True)
class Rule:
    name: str
    min_qty: int
    pct: int


SEASONAL = Rule("seasonal", 1, 5)
LOYALTY = Rule("loyalty", 1, 3)
WHOLESALE = Rule("wholesale", 25, 12)

ACTIVE = [WHOLESALE]
`,
    "shop/pricing.py": `"""Line prices after the active rules."""
from .catalog import find
from .rules import ACTIVE


def best_rule(qty: int):
    fits = [r for r in ACTIVE if qty >= r.min_qty]
    return max(fits, key=lambda r: r.pct, default=None)


def line_price(sku: str, qty: int) -> int:
    base = find(sku).cents * qty
    rule = best_rule(qty)
    if rule is None:
        return base
    return base - base * rule.pct // 100
`,
    "shop/cli.py": `import sys

from .pricing import line_price
from .util import money


def main(argv: list[str]) -> int:
    if len(argv) != 4 or argv[1] != "price":
        print("usage: python3 -m shop.cli price SKU QTY")
        return 2
    print(money(line_price(argv[2], int(argv[3]))))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
`,
  },
  check(_dir, reply) {
    const ok = /threshold\s*=\s*25\b/.test(reply) && /percent\s*=\s*12\b/.test(reply);
    return { ok, why: ok ? "answer right" : `answer: ${reply.trim().slice(0, 120)}` };
  },
};

const pagerTests = `import unittest

from pager.pages import page_count, paginate


class PagerTest(unittest.TestCase):
    def test_first_page(self):
        self.assertEqual(paginate(list(range(10)), 1, 3), [0, 1, 2])

    def test_middle_page(self):
        self.assertEqual(paginate(list(range(10)), 2, 3), [3, 4, 5])

    def test_last_page_short(self):
        self.assertEqual(paginate(list(range(10)), 4, 3), [9])

    def test_past_the_end(self):
        self.assertEqual(paginate(list(range(10)), 5, 3), [])

    def test_page_count(self):
        self.assertEqual(page_count(10, 3), 4)
        self.assertEqual(page_count(9, 3), 3)
        self.assertEqual(page_count(0, 3), 0)


if __name__ == "__main__":
    unittest.main()
`;

const bugfix: Task = {
  id: "bugfix",
  kind: "fix a bug",
  prompt: "The test suite fails. Find the bug and fix it without changing the tests, then run the tests to confirm.",
  files: {
    "README.md": "# pager\n\nPage through result lists. Tests: `python3 -m unittest discover -s tests -t .`\n",
    "pager/__init__.py": "",
    "pager/util.py": pyUtil,
    "pager/pages.py": `"""Pages are numbered from 1."""
from math import ceil


def page_count(total: int, per_page: int) -> int:
    if per_page <= 0:
        raise ValueError("per_page must be positive")
    return ceil(total / per_page)


def paginate(items: list, page: int, per_page: int) -> list:
    if page < 1:
        raise ValueError("pages start at 1")
    start = page * per_page
    return items[start:start + per_page]
`,
    "pager/render.py": `from .pages import page_count


def nav(page: int, total: int, per_page: int) -> str:
    last = page_count(total, per_page)
    prev = f"<{page - 1}" if page > 1 else ""
    nxt = f"{page + 1}>" if page < last else ""
    return " ".join(p for p in (prev, f"[{page}/{last}]", nxt) if p)
`,
    "tests/__init__.py": "",
    "tests/test_pager.py": pagerTests,
  },
  check(dir) {
    const t = pyTests(dir);
    if (t.code !== 0) return { ok: false, why: `tests fail: ${t.out.slice(-200)}` };
    if (sha(readFileSync(join(dir, "tests/test_pager.py"), "utf8")) !== sha(pagerTests)) return { ok: false, why: "tests changed" };
    return { ok: true, why: "tests pass, unchanged" };
  },
};

const feature: Task = {
  id: "feature",
  kind: "add code + tests",
  prompt:
    "Add a `median` function to src/stats.ts and export it: for an even number of values it is the mean of the two " +
    "middle ones, and an empty array throws. Add tests for it to test/stats.test.ts and run the tests with bun test.",
  files: {
    "README.md": "# stats\n\nSmall statistics helpers. Tests: `bun test`.\n",
    "package.json": `{ "name": "stats", "type": "module", "private": true }\n`,
    "src/stats.ts": `// Descriptive statistics over plain number arrays.

export function sum(xs: number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return s;
}

export function mean(xs: number[]): number {
  if (!xs.length) throw new Error("mean of an empty array");
  return sum(xs) / xs.length;
}

export function variance(xs: number[]): number {
  const m = mean(xs);
  return mean(xs.map((x) => (x - m) ** 2));
}

export function mode(xs: number[]): number {
  if (!xs.length) throw new Error("mode of an empty array");
  const counts = new Map<number, number>();
  for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
  let best = xs[0]!;
  for (const [x, n] of counts) if (n > counts.get(best)!) best = x;
  return best;
}
`,
    "src/format.ts": `export const pct = (x: number, digits = 1) => \`\${(x * 100).toFixed(digits)}%\`;
export const fixed = (x: number, digits = 2) => x.toFixed(digits);
`,
    "test/stats.test.ts": `import { expect, test } from "bun:test";
import { mean, mode, sum, variance } from "../src/stats.ts";

test("sum", () => expect(sum([1, 2, 3])).toBe(6));
test("mean", () => expect(mean([1, 2, 3, 4])).toBe(2.5));
test("mean of nothing throws", () => expect(() => mean([])).toThrow());
test("variance", () => expect(variance([2, 4, 4, 4, 5, 5, 7, 9])).toBe(4));
test("mode", () => expect(mode([1, 2, 2, 3])).toBe(2));
`,
  },
  check(dir) {
    const t = run(dir, ["bun", "test"]);
    if (t.code !== 0) return { ok: false, why: `bun test fails: ${t.out.slice(-200)}` };
    if (!readFileSync(join(dir, "test/stats.test.ts"), "utf8").includes("median")) return { ok: false, why: "no median test" };
    const probe = `import { median } from "./src/stats.ts";
const ok = median([3, 1, 2]) === 2 && median([4, 1, 3, 2]) === 2.5 && median([5]) === 5;
let threw = false; try { median([]); } catch { threw = true; }
process.exit(ok && threw ? 0 : 1);`;
    const h = run(dir, ["bun", "-e", probe]);
    return h.code === 0 ? { ok: true, why: "tests pass, median right" } : { ok: false, why: `median wrong: ${h.out.slice(-200)}` };
  },
};

const rename: Task = {
  id: "rename",
  kind: "multi-file edit",
  prompt:
    "Rename the User field `fullname` to `display_name` everywhere in this repo (code and tests, including any " +
    "dictionary keys and method names built from it), keeping behavior the same. Run the tests.",
  files: {
    "README.md": "# accounts\n\nUser accounts: model, serializers, emails and views. Tests: `python3 -m unittest discover -s tests -t .`\n",
    "accounts/__init__.py": "",
    "accounts/util.py": pyUtil,
    "accounts/models.py": `from dataclasses import dataclass, field


@dataclass
class User:
    id: int
    email: str
    fullname: str
    tags: list[str] = field(default_factory=list)

    def initials(self) -> str:
        return "".join(w[0].upper() for w in self.fullname.split() if w)

    def with_fullname(self, name: str) -> "User":
        return User(self.id, self.email, name, list(self.tags))
`,
    "accounts/serializers.py": `from .models import User


def to_dict(u: User) -> dict:
    return {"id": u.id, "email": u.email, "fullname": u.fullname, "tags": list(u.tags)}


def from_dict(d: dict) -> User:
    return User(d["id"], d["email"], d["fullname"], list(d.get("tags", [])))
`,
    "accounts/emails.py": `from .models import User


def greeting(u: User) -> str:
    first = u.fullname.split()[0] if u.fullname.strip() else "there"
    return f"Hello {first},"


def signature(u: User) -> str:
    return f"-- {u.fullname} <{u.email}>"
`,
    "accounts/views.py": `from .models import User
from .serializers import to_dict
from .util import slug


def profile(u: User) -> dict:
    d = to_dict(u)
    d["handle"] = slug(u.fullname)
    d["initials"] = u.initials()
    return d


def rename(u: User, name: str) -> User:
    if not name.strip():
        raise ValueError("fullname cannot be empty")
    return u.with_fullname(name)
`,
    "tests/__init__.py": "",
    "tests/test_accounts.py": `import unittest

from accounts.emails import greeting, signature
from accounts.models import User
from accounts.serializers import from_dict, to_dict
from accounts.views import profile, rename


def ada():
    return User(1, "ada@example.com", "Ada Lovelace", ["admin"])


class AccountsTest(unittest.TestCase):
    def test_round_trip(self):
        u = ada()
        self.assertEqual(from_dict(to_dict(u)), u)
        self.assertEqual(to_dict(u)["fullname"], "Ada Lovelace")

    def test_profile(self):
        p = profile(ada())
        self.assertEqual(p["handle"], "ada-lovelace")
        self.assertEqual(p["initials"], "AL")

    def test_emails(self):
        self.assertEqual(greeting(ada()), "Hello Ada,")
        self.assertEqual(signature(ada()), "-- Ada Lovelace <ada@example.com>")

    def test_rename(self):
        self.assertEqual(rename(ada(), "Ada King").fullname, "Ada King")
        with self.assertRaises(ValueError):
            rename(ada(), " ")


if __name__ == "__main__":
    unittest.main()
`,
  },
  check(dir) {
    const left = walk(dir, ".py").filter((p) => readFileSync(p, "utf8").includes("fullname"));
    if (left.length) return { ok: false, why: `fullname left in ${left.map((p) => p.slice(dir.length + 1)).join(", ")}` };
    const t = pyTests(dir);
    return t.code === 0 ? { ok: true, why: "renamed, tests pass" } : { ok: false, why: `tests fail: ${t.out.slice(-200)}` };
  },
};

// A fan-out read: twelve modules, the answer is a list drawn from all of them.
// The shape programmatic tool calling is for (many reads, a small result).
const AUDIT_MODULES = ["billing", "cart", "catalog", "coupons", "customers", "inventory", "orders", "payments", "reviews", "search", "shipping", "taxes"];
const auditFiles: Record<string, string> = { "shop/__init__.py": "" };
const undocumented: string[] = [];
AUDIT_MODULES.forEach((m, i) => {
  const fns = ["load", "save", "validate", "summarize", "export"].map((f) => `${f}_${m}`);
  const body = fns.map((f, j) => {
    // A deterministic mix: about a third of the functions have no docstring.
    const doc = (i * 5 + j) % 3 !== 0;
    if (!doc) undocumented.push(`shop/${m}.py:${f}`);
    const lines = [`def ${f}(items, limit=100):`];
    if (doc) lines.push(`    """${f.replace(/_/g, " ")} for the ${m} module."""`);
    lines.push(`    out = []`, `    for it in items[:limit]:`, `        if it is None:`, `            continue`, `        out.append(it)`, `    return out`);
    return lines.join("\n");
  });
  auditFiles[`shop/${m}.py`] = `"""The ${m} module."""\n\nimport json\n\n\n${body.join("\n\n\n")}\n`;
});

const audit: Task = {
  id: "audit",
  kind: "fan-out read",
  prompt: "List every function in the shop package that has no docstring, one per line as `shop/<module>.py:<function>`, then the total count. Do not change any file.",
  files: { ...auditFiles, "README.md": "# shop\n\nA small shop backend.\n" },
  check(dir, reply) {
    const missing = undocumented.filter((u) => !reply.includes(u));
    if (missing.length) return { ok: false, why: `missed ${missing.length}: ${missing.slice(0, 3).join(", ")}` };
    const extra = (reply.match(/shop\/\w+\.py:\w+/g) ?? []).filter((x) => !undocumented.includes(x));
    if (extra.length) return { ok: false, why: `listed documented ${extra.slice(0, 3).join(", ")}` };
    return { ok: true, why: `all ${undocumented.length} listed` };
  },
};

// A fan-out over MCP calls the shell cannot make: the list has ids only, the
// answer needs assignee and priority from each ticket (40 calls, ~2 KB each).
const trackerWant = TICKETS.filter((t) => t.status === "open" && t.assignee === "ada" && t.priority === "high").map((t) => t.id);
const tracker: Task = {
  id: "tracker",
  kind: "mcp fan-out",
  prompt: "The tracker MCP server holds our tickets. Find every open ticket assigned to ada with priority high. Reply with their ids, one per line, then the count.",
  files: { "README.md": "# support\\n\\nTickets live in the tracker MCP server.\\n" },
  mcp: { tracker: { command: "bun", args: [join(import.meta.dir, "tracker-mcp.ts")] } },
  check(_dir, reply) {
    const got = reply.match(/T-\d+/g) ?? [];
    const missing = trackerWant.filter((id) => !got.includes(id));
    const extra = [...new Set(got)].filter((id) => !trackerWant.includes(id));
    if (missing.length || extra.length) return { ok: false, why: `missing ${missing.join(",") || "none"}, extra ${extra.join(",") || "none"}` };
    return { ok: true, why: `all ${trackerWant.length} found` };
  },
};

export const TASKS: Task[] = [explain, bugfix, feature, rename, audit, tracker];
