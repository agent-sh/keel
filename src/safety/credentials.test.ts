import { expect, test } from "bun:test";
import { credentialAt, credentialValues, storesUnder } from "./credentials.ts";
import { decide, shellCredentialReads, type Facts } from "./policy.ts";
import { splitCommand } from "./shell.ts";

const home = "/home/u";
const at = { home, state: "/home/u/.local/share/keel/state", config: "/home/u/.config/keel" };

// Thirty places credentials are kept, each a path a model may name.
export const CREDENTIAL_PATHS = [
  ".ssh/id_ed25519", ".ssh/id_rsa", ".ssh/work_key", ".aws/credentials", ".aws/config", ".config/gcloud/application_default_credentials.json",
  ".docker/config.json", ".npmrc", ".pypirc", ".netrc", ".git-credentials", ".kube/config", ".config/gh/hosts.yml", ".gnupg/private-keys-v1.d/a.key",
  ".local/share/keyrings/login.keyring", ".password-store/site.gpg", ".mozilla/firefox/p.default/logins.json", ".config/google-chrome/Default/Cookies",
  ".cargo/credentials.toml", ".vault-token", ".azure/accessTokens.json", ".codex/auth.json", ".claude/.credentials.json", ".pgpass",
  "projects/app/.env", "projects/app/.env.local", "projects/app/config/prod.env", "projects/app/certs/server.key",
  ".local/share/keel/state/api-token", ".config/keel/providers.toml",
].map((r) => `${home}/${r}`);

// Paths that hold none, near the ones that do.
const ORDINARY = [
  ".ssh/known_hosts", ".ssh/config", ".ssh/id_ed25519.pub", ".bashrc", ".config/keel/AGENTS.md", ".config/keel/skills/x/SKILL.md",
  ".local/share/keel/state/spill/s1/out.txt", ".local/share/keel/state/worktrees/repo-1/src/main.ts", "projects/app/.env.example", "projects/app/.env.sample",
  "projects/app/src/env.ts", "projects/app/src/secrets.ts", "projects/app/design/tokens.json", "projects/app/README.md", "projects/app/certs/ca.pem",
  "projects/app/.envrc.md", "projects/app/package.json", ".config/git/config", ".gitconfig", ".config/Code/User/settings.json",
].map((r) => `${home}/${r}`);

test("credential stores, credential names and Keel's own secrets are one class; their neighbours are not", () => {
  expect(CREDENTIAL_PATHS.length).toBe(30);
  expect(CREDENTIAL_PATHS.filter((p) => !credentialAt(p, at))).toEqual([]);
  expect(ORDINARY.filter((p) => credentialAt(p, at))).toEqual([]);
  // The same names anywhere; a store only in the home.
  expect(credentialAt("/srv/app/.env.production", at)?.what).toMatch(/holds credentials by its name/);
  expect(credentialAt("/srv/app/.aws/notes.txt", at)).toBeNull();
  expect(credentialAt("/etc/shadow", at)).not.toBeNull();
  expect(credentialAt("/etc/passwd", at)).toBeNull();
  // A folder that holds stores names them; a project folder holds none.
  expect(storesUnder(home, home)).toContain(`${home}/.aws`);
  expect(storesUnder(`${home}/.config`, home)).toContain(`${home}/.config/gcloud`);
  expect(storesUnder(`${home}/projects`, home)).toEqual([]);
});

test("the values a credential file holds, and not its plain settings", () => {
  const aws = "[default]\nregion = us-east-1\naws_access_key_id = AKIAEXAMPLE7QWERTY12\naws_secret_access_key = wJalrXUtnFEMIK7MDENGbPxRfiCYzz9EXAMPLE\n";
  expect(credentialValues(aws)).toEqual(expect.arrayContaining(["AKIAEXAMPLE7QWERTY12", "wJalrXUtnFEMIK7MDENGbPxRfiCYzz9EXAMPLE"]));
  expect(credentialValues(aws)).not.toContain("us-east-1");
  expect(credentialValues("machine example.com login me password hunter2hunter")).toContain("hunter2hunter");
  expect(credentialValues("//registry.npmjs.org/:_authToken=npm_madeUpToken1234567890abcdefXYZ")).toContain("npm_madeUpToken1234567890abcdefXYZ");
  expect(credentialValues("https://me:s3cretpass@github.com\n")).toContain("s3cretpass");
  expect(credentialValues('{"auths": {"r.io": {"auth": "bWU6bWFkZS11cC1wYXNzd29yZDEyMw=="}}}')).toContain("bWU6bWFkZS11cC1wYXNzd29yZDEyMw==");
  expect(credentialValues("NODE_ENV=production\nPORT=3000\nDB_PASSWORD=correcthorse\n")).toEqual(["correcthorse"]);
  expect(credentialValues("hf_madeUpTokenOnItsOwnLine42\n")).toContain("hf_madeUpTokenOnItsOwnLine42");
});

const facts = (mode: Facts["mode"], more: Partial<Facts> = {}): Facts => ({ mode, workspace: `${home}/projects/app`, sandboxed: false, rules: [], tool: "Read", home, ...more });
const verdict = (d: ReturnType<typeof decide>) => ("allow" in d ? "runs" : "deny" in d ? "refused" : d.ask.ownerOnly ? "owner" : `asks ${d.ask.risk}`);

test("a read of a credential asks the owner, is flagged in Full auto and refused in an agent; a file tool's and a command's alike", () => {
  const p = `${home}/.aws/credentials`;
  for (const mode of ["ask", "auto-edits", "auto", "reviewer", "read-only", "plan"] as const) {
    expect([mode, verdict(decide({ kind: "read", paths: [p] }, facts(mode)))]).toEqual([mode, "owner"]);
    expect([mode, verdict(decide({ kind: "shell", command: "cat ~/.aws/credentials", cwd: `${home}/projects/app` }, facts(mode, { tool: "Bash" })))]).toEqual([mode, "owner"]);
  }
  expect(verdict(decide({ kind: "read", paths: [p] }, facts("full-auto")))).toBe("asks high");
  expect(verdict(decide({ kind: "read", paths: [p] }, facts("full-auto", { agent: true })))).toBe("refused");
  expect(verdict(decide({ kind: "shell", command: "head -5 .env", cwd: `${home}/projects/app` }, facts("auto", { agent: true, tool: "Bash" })))).toBe("refused");
  // Ordinary reads run as before.
  expect(verdict(decide({ kind: "read", paths: [`${home}/projects/app/.env.example`] }, facts("ask")))).toBe("runs");
  expect(verdict(decide({ kind: "shell", command: "cat .env.example README.md", cwd: `${home}/projects/app` }, facts("ask", { tool: "Bash" })))).toBe("runs");
});

test("the shell's reads of credentials: the operands a reader reads, not a searcher's pattern or a name-only program", () => {
  const reads = (c: string, cwd = `${home}/projects/app`) => shellCredentialReads(splitCommand(c)!, cwd, home, (p) => credentialAt(p, at))?.by ?? null;
  expect(reads("grep -rn '.env' src/")).toBeNull();
  expect(reads("rg -e x .env")).toBe("the command reads");
  expect(reads("grep -f ~/.aws/credentials notes.txt")).toBe("the command reads");
  expect(reads("jq . < ~/.docker/config.json")).toBe("the command reads");
  expect(reads("echo $(cat $HOME/.npmrc)")).toBe("the command reads");
  expect(reads("ls ~/.ssh; stat .env; wc -l .env; test -f ~/.ssh/id_rsa")).toBeNull();
  expect(reads("cat ~/.ssh/known_hosts ~/.ssh/id_ed25519.pub")).toBeNull();
  expect(reads("grep -r token ~")).toBe("the command searches");
  expect(reads("rg token", home)).toBe("the command searches");
  expect(reads("rg token")).toBeNull();
});
