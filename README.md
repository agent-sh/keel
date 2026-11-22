# Keel

A coding agent harness in one binary: its own agent loop and tools, every model
your providers list, and a web UI.

```bash
bun install
bun scripts/build.ts
./dist/keel serve --bind 127.0.0.1:47960 --workspace .
```

Open http://127.0.0.1:47960.

Providers are found from the environment: `ANTHROPIC_API_KEY` for the Anthropic
API; `AWS_BEARER_TOKEN_BEDROCK`, AWS keys or `ANTHROPIC_BEDROCK_BASE_URL` for
Amazon Bedrock. Models come from each provider's own listing.

## Turn receipts

`GET /api/debug/turns/<turn_start event id>/receipt` joins the turn's input and
queue IDs, model request spans, tool spans and result events, and the terminal
event and reason. Each request has a `purpose`: `turn` for the turn's own
attempts, `summary` or `reader` for those sent while it ran, else `other`.
The Traces API lists the turn ID as `attrs.turn_event`. A
receipt follows its own branch, even after the session switches branches. It
contains metadata only: no prompts, replies, tool arguments or output, error
messages, or wire data. An `end` of `null` means no terminal event was
recorded. A null span ID means the span is not available, not that the tool
was necessarily skipped.

## Session timeline

`GET /api/sessions/<id>/timeline` is a session's story from one place: its
turns (who started each: the owner, a queued prompt, a steer, the owner's
Resume, a loop run, a wait wake, an agent report, another session, a harness
note, a daemon restart; how it ended; how long it took; its steps, tool calls
and failed tool calls; tokens and cost), the agents it started and how each
ended, waits set and fired, loop runs, compactions, model switches, restored
files, approvals asked and settled, and what failed. Rows are newest first,
`limit` at a time (50 by default, at most 200); `next` is the cursor of the
following page (`before`). `only` is `failures`, `turns` or `agents`. `since`
is a span back from now (`90s`, `30m`, `1h`, `2d`), epoch milliseconds or an
ISO time: nothing older is read or returned. `as_of` is when the page was
read. `now` says what the session is doing: the running turn's step and tool
and the calls that failed in it so far, what waits on the owner, the waits and
agents still out, what is queued. What `now` says (the running turn, a card
still open) is not a row too.

What the rows mean:

- A turn is one row, at its start. Its steps are the replies the model gave.
  Its failed tools are the calls that ran and failed. A call the owner, a
  rule or the judge denied is a denied call, and a call the turn's stop or a
  restart reached is only a tool call: neither is a failure. Its tokens and
  cost are the turn's rollup over every request made while it ran (its own, a
  reader's, a summary's), else what its end summed.
- A wait that fired or an agent that reported, when that is what started the
  next turn, is told in that turn's row ("Wait wake (a timer, after 3 s)",
  "Agent report from ...") and has no row of its own.
- A turn a daemon restart cut says so in its own row, and the turn that went
  on after it starts with "Resumed after a daemon restart". A prompt the
  daemon went down on before its turn began is one row that says that.
- A turn that is not on the branch the session shows is marked
  (`turn.branch: "other"`) and says "on a branch not shown".
- A failed model request is a row per cause from the session's own failure
  record, with this session's count and its agents'. A row from the errors
  table marks only where a kind of failure last happened; its count is over
  every session and says so.
- `only=failures` reads at most 500 rows for a page (`scanned`) and gives
  `next` when it stopped there, with however many rows it found. `turns` and
  `agents` read only their own source and need no bound.

Each row carries the IDs that open its detail: `turn_event` (the turn's
receipt and trace), `refs.child_session` (an agent's session), `refs.error_id`.
Like the receipt it holds metadata only: IDs, kinds, counts, classes,
durations and session titles, never a prompt, a tool's input or output, a
wait's note or an error's message. Turns, compactions and restarts come from
the session's events and are kept as long as the session; agents, waits, loops
and approvals come from the activity list, which keeps 30 days. An activity
row keeps the turn it happened in (`turn_event`); an agent's own session reads
its rows from its parent's list.

`format=text` gives the same story as plain text, a line a row, for a model:
`keel debug timeline SESSION --since 1h` prints it, and `--no-ids` (`ids=0`)
leaves the IDs off the lines. The Timeline side panel shows it live: it asks
only for what is newer than what it holds, and not at all from a hidden tab.

## Every session at once

`GET /api/overview` answers across sessions what the timeline answers for
one: what needs the owner, what failed and why, what runs and for how long,
and the turns and spend since a time (`since=1h`, a day by default, at most
seven days back). A
session's state is the word its row shows on the page. Like the timeline it
holds metadata only: titles, states, failure classes, counts, durations and
IDs.

`format=text` is the short form for a model or a terminal: twenty rows stay
under 1.5k tokens also when every row is heavy. The tokens are counted from
the text's shape, never under what a local BPE measured on these texts, and a
text over the bound is written again with less in each row, never with fewer
rows.
`keel status --sessions --since 1h` prints it (`--no-ids` leaves the IDs
off, `--max N` lists another number), and a session reads it with
`keel__sessions_list` and `report: true`, which lists the agents it started
first. A row names its session by the last twelve characters of its ID, which
the timeline route, the commands that name a session and
`keel__session_send` take. Twenty sessions are listed by default, the ones
that need the owner first; the rest are counted.

The turns counted are the sessions' own; how their agents ended is counted
beside them, and the spend is everyone's. A turn a daemon restart cut is not
a failure: it is continued, and one that was not shows in the session's
state.

"While you were away" is one digest of the same read: per session the turns
that ended, the failures by class, how its agents ended, the approvals that
wait, the agents parked on a wake of their own, and the spend.

- The owner is present while they do something in a page: each page reports
  how long ago its last key, pointer or wheel input was. A page that only has
  focus is not the owner. An absence is five minutes without input
  (`KEEL_AWAY_MS`).
- Absences are kept as a short list, across daemon restarts, until the digest
  is dismissed, and only what happened inside them is counted. A turn that
  ended while the owner was there between two absences is in neither.
- Time the daemon was not running (it was down, or the machine slept) is no
  absence. An absence in which nothing happened leaves no digest.
- The first line counts the sessions' own turns and, beside them, how their
  agents ended. The text form lists twenty sessions at most, within the
  report's bound, and counts the rest.

The Inbox shows the digest as one line above the alerts that opens into a row
a session, each opening its session. Opening it is seeing it: the daemon lets
it go, and the next absence starts a new one. `GET /api/away` gives it (`format=text`
for the text form, `since=` for a window you name, at most seven days back),
`keel status --away` prints it, and `DELETE /api/away` dismisses it.

## The page: one word per state

A session and an agent have one state, and each state has one word on every
surface: the list's rows and the agents under them, a pane's head, an agent's
card in the transcript, the list of background work, the Inbox, the home
screen, the timeline, and what a tool or the command line is told. The words
are written once, in `src/core/state-words.ts`, which the daemon and the page
both read; the state itself is the daemon's (`src/core/watch.ts`,
`src/automation/state.ts`). A check in `src/ui-conventions.test.ts` fails when
a component writes one of them itself, in any case, or a stylesheet turns one
to capitals. State words are in sentence case.

| State | Word | With what |
| --- | --- | --- |
| Something waits on you | Needs you | an approval, a question, a plan, a secret, an answer, a turn to resume, a message not sent |
| A turn runs, an agent works, or a command it left in the background still runs | Working | the step, "2 agents" ("3 of 5 agents" when the rest wait), "command in background" |
| Nothing runs and something it set up starts the next turn | Waiting | for a timer, a file, a log line, an HTTP check, a process, a monitor, a pull request's checks, another session, an agent, the provider |
| A restart cut the turn and Keel goes on with it | Waiting | to resume |
| A message you sent that its session has not taken yet | Queued | held until its current step ends, until its turn ends, or until it is resumed |
| Its last turn ended | Done | |
| Its last turn failed | Failed | one class: rate limit, overloaded, server error, stream dropped, context full, sign-in, billing, image refused, invalid request, output limit |
| The model refused the turn | Declined | |
| You or its parent stopped it, its step budget ran out, or a restart cut a turn that is not resumed | Stopped | at the step budget, by a restart |
| No turn yet | Not started | |
| Its machine does not answer | Offline | as of the time it last told |

An agent's word is its session's: the row under its parent, its card, the
background list and its own pane read the same. A parent's summary is one
line: how many agents, then each state's mark and count, what needs you and
what failed first and in words. Every agent is in exactly one count, so they
add up; the line's name and tooltip say it whole: `8 agents: 1 needs you,
1 failed, 3 working, 2 waiting, 1 done`. Where a word stands with no reason
beside it (a mark's tooltip, a recent row), a session that only keeps a
command going reads "Command in background", and the counts count it apart
from the ones a turn or an agent works in. Failed and Declined share their
red and differ in their mark (a full square, an empty one). The folded list
has no room for a word: each of its bands is headed by its state's mark and
how many, and its name and tooltip say what it holds ("Failed or declined: 2",
"Done or not started: 4").

Counters, each with one meaning, said in its tooltip and its accessible name:

- What waits on you is one number everywhere: the tab's title `(3)`, the
  app's badge, the home headline's "3 need you", the list's line and the
  phone's dock. It counts things, each once (an approval, a question, a plan,
  a secret), through one function (`waitsOnOwner`).
- The bell counts what is unread: alerts that are new since you last looked.
  Its panel lists what needs you first, in the order it was asked, then what
  else is new, then what you have seen. A request stays under "Needs you"
  while its card waits, read or not, and leaves when it is answered. A
  question whose turn was stopped has no card left: it is read, and its row
  offers nothing.
- The bug counts errors in Keel itself that you have not looked at.

Unread means not seen:

- What ends in a session that is in view, in any pane of a page that has
  focus, is read. A pane counts as in view while most of it is inside the
  window and nothing lies over the panes; one scrolled off the window is not.
- What calls you (an ask, a failure) is not read by being in view. It is read
  when you answer it, go to its session (by a press or a key of yours: a
  change of page nobody made reads nothing), or act in its pane. Its notification
  is held back only while its pane is in view of a focused page you did
  something in within the last minute, and is sent when that stops being true
  and it still waits. A page left open mutes nothing.
- "Mark unread" in a session's menu keeps its mark until you go to the
  session again (a reload does not count); "Clear all unread" (the Inbox's
  "Mark all read", or the command) clears every mark.
- An agent that ends while neither its session nor its parent's is in view is
  marked on its row until one of them is.

## A model traces a failure by itself

The notice a session gets when an agent it started fails has one entry per
cause. Under it, each agent that failed since the last notice has a line with
its own count and its own latest failure as it read (three agents, the last to
fail first; the rest by ID). The agent that failed last shows its failure
whole, the two under it what differs from that (`…/lane-2/…`), or "the same".
A count over more than that says whose it is and over what time. The notice
ends with one line that names the tool and one of those agents, the last to
fail whose session is still there: `keel__session_timeline with session: ID
tells what that agent did and where it failed.` A notice is about 2,500
characters at most: causes past that are one line each (what failed, how
often, in how many agents), and the last line then also names
`GET /api/errors?session=ID`, which lists every cause with each agent's own
failure. It is part of an input in the history, so no session's system prompt
or cached prefix changes for it.

- `keel__session_timeline` takes `session`: an agent the session started, by
  its ID, a prefix of it or its session ID. `open` (`error=ID` or `turn=ID`,
  as a row ends) gives that one failure in full instead of the rows: what
  failed, its trace and the events before it. It holds only the session's own
  work or its agents': no other session's errors, no daemon log line that does
  not name the session, no path of the daemon's and no way to send a request
  again. An error ID that is not the session's, or no longer (a kind of
  failure keeps the last session it happened in), is refused with a pointer
  at the turn's ID, which does not move.
- `keel debug timeline`, `keel debug --session` and the other commands that
  name a session take a session's ID, a prefix that names one session, its
  last twelve characters (no shorter ending), or an agent's ID or a prefix of
  that. So does `GET /api/sessions/:id/timeline`. `keel debug ID` with an ID
  that names no error reads it as a session.

## Auto and Full auto

**Auto** keeps Keel's existing read permissions. In-scope edits, read-only
or confined commands, and standing grants run without review. The configured
judge reviews other ordinary calls and flagged high-risk calls.
A refusal or unavailable judge does not open an approval
card. Auto also refuses actions it cannot review in full, including
login shells and actions that require secret substitution. Explicit sandbox
escalation and other owner-only actions still ask. **Full auto** runs
ordinary work without review and retains its
nonblocking high-risk checks. What the judge is sent of a high-risk action
is its first 4,000 characters, so a longer one (a command, a list of files,
a tool's input) is refused instead of run partly unread; Reviewer mode sends
such an action to you. Tools that explicitly require confirmation
still ask in both modes.
**Auto edits** still asks about ordinary work outside its safe defaults.

[Claude Code](https://code.claude.com/docs/en/permission-modes) separates
classifier-backed `auto` from `acceptEdits` and `bypassPermissions`. Keel
imports those as Auto, Auto edits and Full auto, respectively.
[Codex](https://developers.openai.com/codex/agent-approvals-security) treats
sandboxing separately from approvals and can review eligible approvals
automatically. [OpenCode](https://opencode.ai/docs/permissions/) uses
`allow`, `ask` and `deny` rules scoped by action and resource.

## The command sandbox

With a session's sandbox on (workspace-write), a command runs in
[bubblewrap](https://github.com/containers/bubblewrap): the whole machine is
read-only to it except the session's folder, the temporary folder and the
session's own scratch, and the network is off unless the session turns it on.

### The network of a sandboxed command

A sandboxed command never shares this machine's network. It runs in a
network namespace of its own: its `localhost` is its own, and nothing that
listens on this machine is on it. That covers Keel's own API (a local
caller of your account is the owner to it), your databases and dev servers,
the display's sockets, the local network and the cloud metadata addresses.

With the session's network on, what leaves goes through a proxy the daemon
runs for the repository:

- HTTP and HTTPS to public hosts work for programs that use the proxy
  variables (`HTTP_PROXY`, `HTTPS_PROXY` and their lower-case forms, which
  the sandbox sets, with `NODE_USE_ENV_PROXY=1` for Node): curl, git over
  https, bun, npm, pnpm, cargo, go, uv, pip, gh and most others.
- ssh, and git over ssh, go through the same proxy (the sandbox adds a
  `ProxyCommand` for every host to ssh's system settings).
- The proxy resolves the name once and connects to the address it checked.
  It refuses an address on this machine or a private network (loopback,
  10/8, 172.16/12, 192.168/16, 100.64/10, link-local with the metadata
  address, their IPv6 kin and IPv4 addresses written inside IPv6 ones), also
  when a public name points there, and it never connects to Keel's own
  port.
- What does not speak HTTP proxy cannot leave: raw TCP (a database client
  to a remote server), UDP and QUIC, ping, and a program that resolves names
  itself. There is no resolver inside and no route an answer could be used
  on. Java reads no proxy variables: give it `-Dhttps.proxyHost` and
  `-Dhttps.proxyPort` from `KEEL_SANDBOX_PROXY`, or run it outside.
- A server a sandboxed command starts listens on the sandbox's own
  `localhost`: other commands of the same call reach it, your browser and
  the portal do not. Start a dev server you want to open outside the
  sandbox.

A command that the proxy refused, or that went around it, is told so in its
result. With the network off there is no proxy and nothing leaves.

Cost, measured: a command with the network on starts about 19 ms later
(the relay inside the sandbox); a request takes no measurable extra time;
the proxy and relay carry about 1.2 GB a second from a local source, with
the daemon's loop delayed 0.4 ms on average while they do.

A session can commit. That needs git's own files to be writable, so the
profile opens them and keeps read-only what git would run outside the sandbox
later, for this checkout or another:

- The hooks, `config` and `config.worktree` of the repository and of its
  submodules. In a checkout's own git directory a hooks folder or a
  `config.worktree` that is missing is made empty first, so there is always
  something to keep read-only.
- A session in a linked worktree gets its own directory in the repository's
  common git directory, and the shared stores there: objects, refs, logs,
  and `reftable`, `lfs` and `rr-cache` when the repository has them.
  The top of the common directory is the main checkout's git directory, so
  the session gets a read-only view of it: the main checkout's `HEAD`,
  index and the state of a merge, rebase, cherry-pick, revert or bisect it
  is in the middle of cannot be changed, and none can be planted (a planted
  rebase would run its `exec` line when the main checkout next continues
  one). The view is live: a file there is read as it is now, also one that
  did not exist when the command started, so what the main checkout stages
  or checks out while a command runs is seen by it. Of the logs, those of
  the shared refs are writable; the main checkout's own `HEAD` log is read
  where it is, so a prune or a repack in the worktree keeps what that log
  holds. `info` (exclude patterns, attributes, the sparse list, grafts) is
  read-only too: it steers the main checkout's own git. The worktree's own
  merge, rebase, cherry-pick, revert and bisect keep their state in its own
  directory and work as usual.
- A session in the main checkout keeps its `.git` writable, the state of its
  own operations included. The directories of linked worktrees checked out
  outside its folder are read-only. A worktree it makes inside its folder is
  its own, to commit in and to remove.
- The folders that hold those files cannot be renamed away or replaced.

git is told a few things in a sandbox, through the environment
(`GIT_CONFIG_COUNT`, after any settings the command's own environment
carries):

- In every sandbox a new branch records no upstream. The config is
  read-only there, so `git checkout -b x origin/main` would otherwise fail
  on the upstream it cannot write. Branches made in a sandboxed session
  track nothing until you set that outside it.
- In a worktree session no gc or maintenance starts after a commit (neither
  can run there), `git fsck` does not report that `packed-refs` is a link,
  which it is in the view, and `git repack` does not write the server info
  under `info`, which is read-only there. A session in the main checkout
  runs its gc as always.

What still runs into the read-only config, in every sandboxed session:
`git config`, `git remote add`, `git branch -u`, `git push -u`, `--track`.
`git branch -m` renames the branch and then exits 128, because the branch's
settings cannot be moved; deleting a branch leaves its settings behind.

What a worktree session's read-only view closes, as plain errors from git:
deleting a branch or a tag that is packed, `git pack-refs`, `git gc`,
`git worktree add`, changing a shallow clone's depth, a first `rr-cache` or
`lfs` store, and anything else that makes a new entry at the top of the
common directory. One oddity there: dropping the last stash when
`refs/stash` is packed says "Dropped" and leaves the ref (the list is
empty).

A session whose folder is inside a repository, below its top, cannot commit
with the sandbox on: the git directory is outside its folder. The same
holds for a worktree whose git directories the sandbox cannot open safely.
A command that runs into that is told why.

A command that runs into the read-only top, the read-only config or a
network that is off is told so in its result, with the way its tool asks to
run outside the sandbox: Claude Code's Bash takes
`dangerouslyDisableSandbox: true`, Codex's shell takes
`sandbox_permissions: "require_escalated"`. Each such call is approved
first: by you on a card, and in full auto by what settles a high-risk call
there, which reads the command whole or refuses it.

`git submodule update` of a submodule that is already checked out rewrites
that submodule's config, which is read-only: it fails in a sandboxed
session. A first `git submodule update --init` in a linked worktree works,
and so do commits inside a submodule.

What the sandbox does not stop:

- A session in a linked worktree can write every ref of the repository: move
  or delete a branch another checkout has out, a tag, a stash. git writes
  lock files next to the refs it changes, and a bind covers a path, not one
  ref. After each such command Keel compares the refs with what they were
  and says what changed outside the session's own branch, in the command's
  result and in the session's activity: a ref moved or deleted, a ref made
  where other checkouts read from (a replacement of a commit, notes), and a
  name made to point at another ref. What the session's own commands made
  earlier in the turn is its own. It names what changed while the command
  ran, not who changed it: with several sessions in one repository, another
  session's work can show up there.
- A repository inside the session's folder that the session made or can
  write is its own, hooks and config included: a nested clone, a repository
  it starts with `git init`, a worktree checked out inside its folder. git
  run there by you or by another session runs what its config names, and so
  does `git status` in the repository around it once the nested one is added
  as a submodule. Keel's own git calls never do (`src/core/git.ts`). So is a
  folder whose `.git` is a symbolic link: nothing pins a link, so such a
  folder gets no git protection and no git access.
- In the main checkout, `config` and `config.worktree` are single files in a
  folder the session writes, kept read-only by a bind on each file. When
  another process replaces one of them while a sandboxed command is still
  running (`git config`, a new remote, a branch's upstream), that command
  sees the new file without the bind and can write it until it ends. The
  shared `config` of a linked worktree's repository has no such gap; the
  worktree's own `config.worktree`, which git reads only when the
  repository turns per-worktree config on, has it.
- A command that was moved to the background is compared when the call
  returns, not when the command ends.
- In a repository whose refs are in reftable, the main checkout's `HEAD` is
  a record in the shared ref store, which a worktree session writes. git
  refuses to change another checkout's `HEAD` from a worktree; a program
  that writes the tables itself is not stopped. The report after the command
  names the change.
- A `git pack-refs` or `git gc` you run outside while a worktree session
  deletes a loose branch does not wait for the session's lock, which is
  private to its sandbox: the deleted branch can come back from the packed
  file.

## Keel's own git

Keel runs git by itself in a session's folder: for the file picker, the
Changes panel, checkpoints, worktrees, a session's move and the facts the
permission rules read. git runs programs that a repository's own files name
(a file-system monitor, hooks, a pager, filters and diff drivers that
`.gitattributes` turns on), and a session can write those files. So Keel's
git does not read a repository's own config:

- It reads the repository through a view that holds only the plain settings
  of its config: the format, line endings and file mode, sparse checkout,
  remotes and upstreams, the identity, and `core.excludesFile`. Your global
  and system config apply as always. Nothing a repository's config includes
  from another file is read: an excludes file named only through
  `include.path` is not honoured, and the files it leaves out show as new.
- One filter is taken from a repository's own config: Git LFS, when its
  `filter.lfs` section is exactly what `git lfs install --local` writes
  (`clean`, `smudge`, `process` and `required`, nothing changed or added).
  It runs the `git-lfs` program found on Keel's `PATH`, by its whole path,
  and never one inside the repository's main checkout or one of its
  worktrees.
- Any other filter or driver defined only in a repository's config (git-crypt,
  `git lfs install --local --skip-smudge`) is not run by Keel. A worktree
  Keel makes there holds the files as git stores them (encrypted, or as LFS
  pointers), the Changes panel shows such files as changed, and a move to a
  worktree leaves them that way in the main checkout too. Run your own
  `git checkout` there to put them back, or set the filter up in your global
  config.
- Hooks, the file-system monitor, external diffs and text conversions, a
  repository's own credential helpers, ssh command and http settings are
  never used. Opening a pull request from Keel pushes with your global setup.
- A remote can be a folder on this machine, and that folder's repository has
  a config of its own. A push or a fetch from Keel runs none of its hooks,
  no file-system monitor and no program it names for the refs of its
  alternates, and starts no gc there. A push into a branch that is checked
  out in that folder is refused (updating the files there would run that
  repository's filters): check out another branch there, or push to a bare
  repository.
- A repository of another user is not opened unless you listed it in
  `safe.directory`, as with git itself.
- In a partial clone, reading never fetches: a diff that needs a file that
  is not here shows the list of files without the patch. Making a worktree
  and restoring one fetch the files they put in the folder, from the
  remote's address and with your own transport settings only. The address is
  the repository's to name, so that fetch reaches no further than the
  session the worktree is for reaches with its own commands:
  - a session whose sandbox is off: any address;
  - a sandboxed session with its network on, and a worktree you make
    yourself with no session behind it: any address the web tools reach,
    so none on this machine or a private network (`localhost`, a private or
    link-local address, a host name with no dot);
  - a sandboxed session with its network off: nothing is fetched.

  Only https, http, ssh and git are spoken, and a folder on this machine
  that the repository names as its remote: no other transport program is
  started. When nothing is fetched, or the fetch fails, nothing of the
  worktree stays and the answer names the command that fetches the files.

A folder can hold other repositories: a submodule that is checked out, or a
folder with a `.git` of its own, also below a folder git does not track.
Keel's git never runs inside one from outside. It records each by the commit
it has out, as git does, so:

- A checkpoint, a parked worktree and a session's move hold the commit of a
  repository inside the folder, never the uncommitted work in it. A rewind
  does not put that work back. This is how git's own snapshot of a folder
  works, and how Keel worked before.
- A worktree is not removed, parked or moved back to the main checkout while
  a repository inside it holds what would go with the folder: uncommitted
  work, commits of a submodule that none of its remotes has, or a repository
  git does not track. Keel asks each one and names it. One that cannot be
  read counts as holding work. A submodule's commit that the main checkout's
  copy of that submodule also holds is not lost with a worktree, and holds
  nothing back.
- A move from the main checkout to a worktree takes the outer work. A
  submodule's own changes stay in the main checkout, and the move says so. A
  repository git does not track stops the move.

## Hooks

Keel reads hooks in the shape Claude Code and Codex share:
`{ "hooks": { "<Event>": [{ "matcher": "...", "hooks": [{ "type": "command", "command": "..." }] }] } }`.
Your own file, `hooks.json` in Keel's config folder, always runs. A
repository's `.keel/hooks.json` runs only after you read it and pin it in
Settings, Hooks. The pin holds the file and every script under `.keel/` its
commands run. A changed file or script runs nothing until you pin it again.

### Events

Every hook gets one JSON object on stdin: `session_id`, `cwd`,
`hook_event_name`, `model`, `permission_mode` (Keel's mode under Claude Code's
name, with Keel's own in `keel_permission_mode`), `transcript_path` (always
`null`: a session is rows in Keel's store, not a file), and the event's own
fields. Inside a subagent `session_id` is the parent's, and `agent_id`,
`agent_type` and `agent_session_id` name the agent.

A `matcher` of letters, digits, `_`, `-`, spaces, `,` and `|` is a list of
exact names. Anything else is a regular expression, tested unanchored. No
matcher, `""` and `"*"` match all. A hook's `if` (`Bash(rm *)`, `Edit(*.ts)`)
narrows it further on the tool events; on other events a hook with `if` never
runs.

These fire, most used first:

| Event | When | Matcher | Own fields | What its hooks can do |
| --- | --- | --- | --- | --- |
| `SessionStart` | The first prompt of a session, and the first prompt after its context was cleared or compacted | `source`: `startup`, `clear`, `compact` | `source` | Add context (plain stdout or `additionalContext`) |
| `Stop` | A turn ends by itself, outside a subagent | none | `stop_hook_active`, `last_assistant_message` | Exit code 2 or `decision: "block"` sends the session back to work with the reason, five times in a row at most (a daemon restart does not start the five again). `continue: false` from any hook lets it stop |
| `UserPromptSubmit` | A prompt is about to reach the model | none | `prompt` | Block the prompt, add context |
| `PostToolUse` | A call ran and did not fail | tool name | `tool_name`, `tool_input`, `tool_response`, `tool_use_id`, `duration_ms` | Add context to the result. A block is told to the model: the call already ran |
| `PostToolUseFailure` | A call's result is an error, or its tool threw | tool name | `tool_name`, `tool_input`, `tool_use_id`, `error`, `is_interrupt`, `duration_ms` | Add context to the result |
| `UserPromptExpansion` | You run a slash command, before its prompt is stored | command name | `expansion_type`, `command_name`, `command_args`, `command_source`, `prompt` | Block the command, add context |
| `PreToolUse` | Before a call, before the permission gate | tool name | `tool_name`, `tool_input`, `tool_use_id` | Block, ask, allow, change the input, add context (see below) |
| `StopFailure` | A turn ends in an error, or at the output limit | error type: `rate_limit`, `authentication_failed`, `billing_error`, `server_error`, `invalid_request`, `max_output_tokens`, `unknown` | `error`, `error_details`, `last_assistant_message` | Told only |
| `SubagentStop` | A subagent's turn ends by itself | agent type | `stop_hook_active`, `agent_transcript_path` (`null`), `last_assistant_message` | Told only: the agent's report is already on its way to its parent |
| `SessionEnd` | A session is archived or deleted, once | `reason`: `other` | `reason`, `keel_reason` (`archived`, `deleted`) | Told only. 1.5 s unless the hook names a timeout, 60 s at most |
| `PermissionRequest` | An approval card is about to open | tool name | `tool_name`, `tool_input`, `keel_risk`, `keel_reason` | `decision.behavior` `deny` refuses the call. `allow` answers the card where a `PreToolUse` allow would (see below). An allow that carries `updatedInput` or `updatedPermissions` is not taken. Exit code 2 does nothing here |
| `PreCompact` | Before a compaction | `trigger`: `manual`, `auto` | `trigger`, `custom_instructions` | The compaction waits for it. It cannot block: a compaction at the window has to happen |
| `SubagentStart` | A subagent's first prompt | agent type | none | Add context for the subagent |
| `PostCompact` | A summary took the place of the history | `trigger` | `trigger`, `compact_summary` | Told only |
| `Notification` | Keel raises an alert for a session | `notification_type`: `permission_prompt`, `agent_needs_input`, `idle_prompt`, or Keel's alert kind | `message`, `title`, `notification_type`, `keel_kind` | Told only |
| `PermissionDenied` | The judge or the reviewer refuses a call without you | tool name | `tool_name`, `tool_input`, `tool_use_id`, `reason` | Told only: the retry is yours to allow |
| `PostToolBatch` | All calls of a step returned, before the next model request | none | `tool_calls` | Add context. A block stops the turn as your stop does |
| `Interrupt` | You stop a running turn, outside a subagent | none | none | Told only. 1 s, 3 s at most |
| `PreModelRequest` | Before every request to a model, a retry too | none | `model`, `purpose` | Told only |
| `PostModelRequest` | That request ended | none | `model`, `purpose`, `status`, `error`, `token_usage` | Told only |

The last three are Codex's. A hook that is told only runs beside the session:
nothing waits for it, and nothing it answers changes what Keel does.

These never fire. A file that names one loads, and its list in Settings says
why the event never runs:

| Event | Why |
| --- | --- |
| `Setup` | Keel has no init or maintenance run |
| `InstructionsLoaded` | Instruction files are part of the system prompt Keel keeps with the session. No hook point reads them yet |
| `MessageDisplay` | The page renders the reply as it streams |
| `TaskCreated`, `TaskCompleted` | The task list is written whole by one tool. A `PreToolUse` or `PostToolUse` hook on that tool sees it |
| `TeammateIdle` | Keel has no agent teams |
| `ConfigChange` | Keel reads its config files when it uses them and watches none |
| `CwdChanged` | A session's folder does not change while it runs |
| `DirectoryAdded` | No hook point where a folder is added to a session yet |
| `FileChanged` | Keel watches no files for a session |
| `WorktreeCreate`, `WorktreeRemove` | Keel makes and removes its agents' worktrees itself |
| `PreModelSwitch`, `PostModelSwitch` | No hook point on a model switch yet |
| `Elicitation`, `ElicitationResult` | Keel's MCP client answers no elicitation request |

Also not done: `SessionStart` with `resume` or `fork` (a session lives in the
daemon and a fork copies its history, so neither is a new start),
`defer`, `updatedToolOutput`, `updatedMCPToolOutput`, `suppressOutput`, and
`async` (such a hook runs like any other and is waited for).

The event list and fields are from the
[Claude Code hooks reference](https://code.claude.com/docs/en/hooks) (33
events) and the [Codex hooks page](https://developers.openai.com/codex/hooks)
(14 events, three of them its own), read on 2026-11-21.

### Where Keel differs from the two documents

- Fields not sent: Codex's `turn_id`; Claude Code's `prompt_id`, `effort`,
  `scratchpad_dir` and `mcp_server`; Stop's `background_tasks` and
  `session_crons`.
- Plain stdout is context for the model on `PreToolUse`, `PostToolUse`,
  `PostToolUseFailure` and `PostToolBatch` too. Both documents ignore it
  there.
- `systemMessage` goes to the model as context, not to you as a warning.
- A `PreToolUse` or `UserPromptSubmit` hook that answers JSON Keel cannot
  read blocks. Both documents let the action go ahead.
- `continue: false` on `PreToolUse` blocks that call and does not end the
  turn.
- A `Stop` hook's `additionalContext` is ignored. A `PreCompact` hook's
  stdout is not used as summary instructions.
- `StopFailure`'s `last_assistant_message` is the model's last text. The
  error is in `error_details`.
- `UserPromptExpansion`'s `prompt` is the text the command expands to, not
  the line you typed.
- A failed call fires `PostToolUseFailure` and not `PostToolUse`, as in
  Claude Code. Codex fires `PostToolUse` for a failing Bash command.
- `SubagentStop` and `PreCompact` cannot hold what they are told of back.
- An allow answers less than in either document: see the table below.

### Handlers

A hook's `type` says what runs. Every kind is under the same rule: a
repository's file runs only pinned, and the pin holds the URL or the tool it
names.

| `type` | Fields | What runs |
| --- | --- | --- |
| `command` | `command`, `timeout`, `onFailure` | The command in bash, with the event on stdin |
| `command` with `args` | `command`, `args` | The program itself with those arguments, no shell. `${KEEL_PROJECT_DIR}` and `${CLAUDE_PROJECT_DIR}` are filled in |
| `http` | `url`, `headers`, `allowedEnvVars`, `timeout`, `onFailure` | A POST of the event as JSON. A header takes an environment variable (`$NAME`, `${NAME}`) only when `allowedEnvVars` lists it |
| `mcp_tool` | `server`, `tool`, `input`, `timeout`, `onFailure` | A tool of an MCP server Keel is connected to. `${tool_input.file_path}` in `input` is filled from the event: alone it keeps its type, inside a text it is written into it |

An `http` hook answers with a 2xx status. No body is a hook with nothing to
say. A JSON object is its answer, read like a command's stdout. Any other
body, any other status, a redirect and a failed connection are a failed hook:
the text never reaches the model, and the action goes ahead unless the hook
has `onFailure: "block"`.

An `mcp_tool` hook's text is read like a command's stdout. An error answer,
a server that is not connected and a missing tool are a failed hook. The call
asks for no approval and runs no other hook: you chose the tool when you
wrote or pinned the file.

`prompt` and `agent` hooks are read and not run, as in Codex. Each asks a
model on every event. Keel's model checks on a call are the judge and the
reviewer, on the model you chose for them. Settings lists such a hook in the
file's notes: the file loads, and the hook never runs.

A hook that fails (any exit code but 0 and 2, a command that is not there, a
timeout, a port nobody listens on) is one row in Errors with its command or
URL, its event and its session. The action goes ahead unless the hook has
`onFailure: "block"`. A command hook runs in the session's folder, or in your
home folder when that folder is gone or on another machine.

What a hook says is bounded and inert. Each reason, context text and Stop
prompt is cut at 10,000 characters. A hook's stdout, its stderr and an `http`
answer are read to 1 MB; a longer `http` answer is a failed hook. No tag
reaches the model from a hook: every `<` that could open or close one is
written `&lt;`, so a hook's text closes no frame and opens none, and the
marks `[harness]` and `[hook]` are rewritten wherever they stand. A Stop
hook's reason is sent as a prompt marked `[hook]`, under the same rules.

Before you pin a repository's file, Settings shows all of it, each URL an
`http` hook sends your prompts, tool inputs and tool results to, each MCP
tool a hook calls, and each script a command runs from outside `.keel/` and
`.claude/`: the pin does not hold such a script, so it runs as it is on disk
when its hook fires. A file longer than 400,000 characters is not pinned.

An event no hook file names costs one look at the hook files' text. The
scripts a pinned file covers are read only for an event the file names.

### What a PreToolUse hook can do to a call

A `PreToolUse` hook runs before the permission gate. It answers with
`hookSpecificOutput.permissionDecision` and, to change the call,
`hookSpecificOutput.updatedInput`.

| Answer | What Keel does |
| --- | --- |
| `deny`, exit code 2, or `decision: "block"` | The call does not run. The model reads the reason. |
| `ask` | The call goes to you on a card, after the gate let it through. The card takes no standing answer. |
| `allow` | It answers the card you would have got for this call, once, when the call stays inside what the session may already touch. Nothing else. |
| `updatedInput` | The call's input is replaced before anything judges it. |

Between hooks, a deny beats an ask and an ask beats an allow. When several
hooks change the input, the first one in file order wins, your file before
the repository's. An allow then counts only from the hook whose input won:
another hook allowed the call as the model wrote it, not the one that runs.

The rule for an allow: it answers only a question you would have been asked,
for a call that stays inside what the session may already touch, and nothing
else. Exactly:

| The call | With a hook's allow |
| --- | --- |
| An edit whose every path is inside the workspace or the session's scratch folder, in Ask | Runs without a card |
| A command the session's sandbox confines, in Ask | Runs confined, without a card (a patch sent through the shell tool is an edit, not such a command) |
| An edit with a path outside the workspace and the scratch folder | Still asks |
| A command with no sandbox to confine it | Still asks |
| A tool (an MCP tool too) or a message into another session | Still asks: only your own rule allows it |
| Anything in Auto or Reviewer | The judge or the reviewer still decides, and the Auto size limit holds |
| Anything in Full auto | Unchanged: ordinary calls run, flagged ones go to the judge |
| A high-risk action, a tool that confirms every call, an escalation out of the sandbox | Still asks |
| A command that never runs without you | Still refused or asked |
| Anything in Read only or Plan | Still refused |

So an allow hook makes Ask run what Auto edits runs without asking, and
never more. In Auto edits those calls already run, and the allow changes
nothing there. The sandbox still confines whatever a hook allowed. A
`PermissionRequest` hook's allow follows the same table.

Some changes are yours alone, one card each, whatever a hook, a grant, the
sandbox, the reviewer or the judge says:

- a file a repository runs later: git hooks, `.envrc`, the project's hook and
  MCP files, the hook scripts under `.keel/hooks/` and `.claude/hooks/`;
- any file in Keel's own config folder: your hooks file there runs with no
  pin, as do its MCP servers, skills and agents;
- a script your hooks, or a pinned repository's hooks, run by its path;
- in your home folder: a shell's start file (`.bashrc`, `.profile`, `.zshrc`
  and the like, `.bashrc.d/`), `.ssh/`, git's configuration (`.gitconfig`,
  `.config/git/`), `.local/bin/`, and the session start folders under
  `.config/`.

That holds however the change is asked for: an edit tool, a patch (its files
are read by the patch tool's own parser), a patch sent through the shell
tool (Keel applies it itself, so it is judged as the edit it is and no
sandbox answers for it), a command whose plain shape writes the file (a
redirect, `tee`, `cp`, `mv`, `rm`, `install`, `ln`, `sed -i`, `dd of=`), and
a tool given the file's path (an MCP file server). It does not see every
write a command can make: a script or an interpreter that writes the file is
judged as the command it is. Full auto runs all of these, as before.

An approval is for exactly the input its card shows, all of it. A card left
open across a daemon restart is closed when the call comes back with another
input (a hook answered differently the second time, or not at all), and the
call is judged as new. A card whose call went on without it is closed too.

In the page a card is answered only for what was read. It keeps which lines
of its text have been in view, and takes no answer until all of them have: a
long text is opened and scrolled through first, and the card says how much is
left. An edit's card shows what the edit writes, read the same way. The
keyboard never lands on Allow once by itself where the request asks for a
second look: high risk, an input shown in part, or a text with characters
that are hidden, reorder it, are written right to left or can pass for plain
letters. There the answer is one deliberate key away, and the card says which.

The rule is the daemon's as well, so it holds for every way to answer: the
phone app and its notification, `keel approve`, `keel attach`, an editor over
ACP, a script, a page on another machine. See "Approvals away from the page"
below.

A changed input is the one the gate judges, the one an approval card shows
and the one that runs. A changed shell command must be text: a list or an
object there is refused. The session's history keeps what the model wrote. The
model reads the input that was judged on the call's result, and whether it ran. The call's card shows
the input that ran and names what the model asked for. The call's trace span
carries `hook_rewrote` and the size of the input the model wrote, and
`hook_allowed` when a hook's allow answered an ask. For a tool that runs
another tool (`mcp_call`), the hook sees and changes that tool's arguments.

The documented contracts, read on 2026-11-21:
[Claude Code hooks](https://code.claude.com/docs/en/hooks) evaluates deny
and ask rules whatever a hook allows, and judges the returned input, not the
one the model sent. [Codex hooks](https://developers.openai.com/codex/hooks)
accepts `updatedInput` together with `allow`. Keel's allow is narrower than
both: it never answers for a call that leaves the session's own scope.

## Subagent concurrency

From the machine running the session's daemon, set a limit for that session:

```bash
curl -fsS -X PATCH http://127.0.0.1:47960/api/sessions/SESSION_ID/agents \
  -H 'Content-Type: application/json' -d '{"limit":12}'
```

`GET` on the same path shows the effective limit. Set `limit` to `null` to
return to `KEEL_MAX_SUBAGENTS` (8 when unset). The override survives a restart
and does not change other sessions. Starting, running and waiting agents
occupy slots. Lowering the limit does not stop any agents. Blocking spawns
wait for room. Background spawns and agent messages that would restart a
finished agent are refused while the session is full. A turn the owner
starts on an agent's own page is not refused. The daemon that owns
the parent counts its agents even when their tools run on another machine.

## Diagnostics after an edit

Off unless you turn it on (Settings, Language servers, or `diagnostics.mode`).
On, an edit's own result carries the type errors and other compiler
diagnostics that edit caused, from the language server of the file's project.
No build runs, and an edit that caused none adds nothing.

```
<diagnostics server="typescript">
1 new error.
src/math.ts:2:3 error TS2322 Type 'string' is not assignable to type 'number'.
</diagnostics>
```

What it costs: a language server per folder being edited. The TypeScript 7
server holds about 0.6 to 1.2 GB on a project of two thousand files. At most
four servers are alive and hold 3 GB together (`max_servers`,
`max_memory_mb`); the one used least recently ends first and starts again at
the next edit in its folder. Each runs in a scope of its own with a 1.5 GB
memory limit and half the CPU and IO weight, sandboxed or not.

What the model is told:

- Only what the edit changed. The file's diagnostics are asked before the
  edit and after it. A diagnostic is the same one when its message, code and
  the words of its line match, whatever the line's number: the ones the file
  has more of are new and listed, the ones it has fewer of are a count
  (`1 fixed, no errors left.`). A file that was already broken is not blamed
  on the edit, and an error on a line the edit rewrote that is still on it
  reads `1 error still on the changed line`, not as a new one.
- Errors only, unless the mode is "errors and warnings". At most ten are
  listed, errors first, each as `file:line:col`, its code and its message.
  The block is at most 1,500 bytes and fits inside the result's cap; a
  server's words reach the model on one line, with no tag, harness mark,
  control or direction character in them.
- Files the session edited before are asked again too, for a server that
  answers requests: an edit that breaks a caller it wrote earlier says so.
- The block is part of the tool result, written once. Nothing is sent as a
  separate message, so the provider's cache prefix is as it was.

The wait is bounded (`wait_ms`, 1500; a server still starting gets the same
time to be ready first). A server that has not answered by then is not
waited for: the result says the file is not checked yet, and the answer goes
with the result of the session's next edit, or of its next read of that
file, also when it is "checked: no new errors". A file a server could not be
asked about is said to be not checked, never passed over.

Servers are found, never installed. Each is an entry of data: the extensions
it reads, the files that mark a project root, and the commands that may start
it. The built-in ones are looked for in the modules of the project root and
of the folders up to the session's folder (no higher), then on `PATH`.

| Server | Files | Found when | On by itself |
| --- | --- | --- | --- |
| TypeScript | `.ts .tsx .mts .cts .js .jsx .mjs .cjs` | the project has TypeScript 7 (its compiler is its own server) or `tsgo` | yes |
| TypeScript 6 and older | the same | `typescript-language-server`, once you turn the TypeScript server on by name: it loads the project's tsserver and tsconfig plugins | no |
| Ruff | `.py .pyi` | `ruff` is on `PATH` or in `.venv/bin` | yes |
| Pyright | `.py .pyi` | `basedpyright-langserver` or `pyright-langserver` | no |
| Go | `.go` | `gopls` | no |
| Rust | `.rs` | `rust-analyzer` | no |
| C and C++ | `.c .h .cc .cpp ...` | `clangd`, and a `compile_commands.json`, `compile_flags.txt` or `.clangd` | no |

The same settings entry turns a server on, changes one or adds one. A command
you write there is a name on `PATH` or a whole path, never a file of a
repository with that name.

```json
{ "diagnostics": {
    "mode": "errors",
    "workspaces": { "/path/to/repo": "off" },
    "max_servers": 4, "max_memory_mb": 3072,
    "servers": {
      "rust-analyzer": { "enabled": true },
      "zls": { "command": ["zls"], "extensions": { ".zig": "zig" } }
    } } }
```

`mode` is `off`, `errors` or `warnings` (errors and warnings); `workspaces`
gives a folder its own.

When a server starts, and where it runs:

- A server whose program is a file of the workspace (its modules, its
  virtual environment), or that loads the workspace's code (a plugin, a build
  script, an interpreter), is the workspace's program. An edit starts it only
  where the session already runs commands without asking: inside the sandbox
  in Auto edits, Auto and Full auto; outside a sandbox only in Full auto with
  the sandbox off. In any other session it starts once you trust that
  folder's language servers in Settings. First sight is no trust, a folder
  that is no repository is not trusted for being none, and opening the page
  writes nothing.
- A program of the machine that loads nothing of the workspace (a `ruff` on
  `PATH`) starts in any mode.
- It runs inside the sandbox of the session whose edit started it: the same
  bubblewrap profile as that session's commands, the network off unless the
  session has it. When the session is sandboxed and the machine cannot
  sandbox, no server starts.
- The files a server starts from are the owner's to change, like a hook:
  `node_modules/.bin`, the TypeScript and Pyright packages, `.venv/bin`, a
  `plugins` entry in a tsconfig, the interpreter or environment in a Pyright
  configuration. An edit of one asks you, in every mode but Full auto: a new
  entry, a change inside one the file already holds (read against the file
  as it is, where the edit lands), and any patch of a file that holds one.
  The same goes for a file of a folder that is on the session's `PATH` and
  inside its workspace, whatever would run it: commands are found there by
  name.
- What a trusted server loads is still the folder's code. The files a plugin
  or an interpreter is made of are ordinary files, and a sandboxed command
  can write any file of the folder. A server started from them runs inside
  the sandbox in a sandboxed session, trusted or not. Trust in a session
  without a sandbox is trust in what the folder's servers load.
- One per language, project root, session folder and sandbox profile.
  Sessions of one folder with the same profile share it; a session in a
  linked worktree gets a server rooted there, and none once that folder is
  gone.
- It ends after `idle_minutes` (5) without an edit and starts again when its
  configuration files change. After a command, every document it has open is
  given again from disk, the files the repository says changed are named to
  it, and a commit restarts nothing. Outside a repository nothing says what a
  command changed, so the server starts again. The repository is asked
  through the daemon's own git, where its config is not in force: no monitor,
  hook or filter it names runs.
- A server that floods, stops reading, stops answering or exits is ended and
  started again at a later edit, after a pause that grows from one second to
  ten minutes. No server starts while the machine has less than
  `min_free_mb` (2048) of memory available or reports memory pressure.
- Its processes are in the Resources panel as kind `lsp`, booked to the
  session that started it. It ends with the daemon; one a killed daemon left
  is ended by the next start.

Each wait is a span of its turn (kind `wait`, name `diagnostics`): the
server, the milliseconds, whether it timed out, the errors, warnings and fixes
it found, and the tokens the block added. Settings, Language servers shows
the totals since the daemon started, how many servers are alive and what they
hold.

Not covered: a session whose tools run on another machine (its files are
there, and no server is started for it), and diagnostics in files the session
has not edited.

## Refresh the frontend without restarting

Build the page from the daemon's source revision, with only the UI changes
applied. Check the daemon's UI status, then install the bundle:

```bash
bun scripts/build.ts --ui dist/keel-ui.tar.gz
keel ui status --url http://127.0.0.1:47960
keel ui install dist/keel-ui.tar.gz --url http://127.0.0.1:47960
```

The daemon validates the bundle's API stamp. If the server sources differ,
rebuild against the running revision or update the binary in a planned restart.
Keel never restarts the daemon for a UI install. Idle pages reload, and a page
with a draft offers a reload and keeps the draft. `keel ui rollback` switches
back to the previous bundle, or to the embedded page.

## Package and check a release

```bash
bun scripts/release.ts                 # dist/release: keel-<target>.tar.gz, SHA256SUMS, release.json
scripts/release-check.sh               # verify it as a machine that installs it would see it
```

`scripts/release.ts` builds the binary for this machine's target (or
`--target bun-darwin-arm64` and the like) and packs it with its UI bundle and
the license. `release.json` names the git revision (marked `-dirty` when the
tree had changes), the target, the API fingerprint and the checksum of each
file; `SHA256SUMS` holds the archive's. Nothing is published.

`scripts/release-check.sh` verifies the checksums, unpacks the archive into a
throwaway folder outside the source tree and runs the binary with a clean
environment and no Bun on `PATH`: `keel --help`, `keel --version` against the
release's revision, the daemon on the loopback, its embedded page and every
file of it, and the release's UI bundle installed over the running daemon and
rolled back. No model is called. A release for another platform is packaged
the same way and has to be checked on that platform. To drive the page of a
built binary in a browser: `scripts/smoke.sh --bin PATH/keel`.

To install by hand, verify and unpack the archive, put `keel` on your `PATH`,
and run `keel serve` (or `keel service install` for a systemd user unit).

## Browser check without credentials

```bash
scripts/smoke.sh                               # the smoke case: a chat with a tool call
scripts/smoke.sh test/e2e/copy.spec.ts         # other specs the same way
```

The command starts a daemon of its own on the scripted stand-in provider, runs
the Playwright specs against it and stops it. Nothing of the caller reaches the
run: the daemon and the browser get a clean environment, a `PATH` of Bun, Node
and the system's tools, no keyring (no session bus, a runtime folder of their
own) and a throwaway folder for their home, state, config, workspace,
screenshots and traces. No key is read, and `KEEL_URL` cannot point the specs
at another daemon. Before a spec runs, the daemon is asked which providers it
has: a run whose daemon has any besides the scripted one is refused.

They run in namespaces of their own: a network with only a loopback interface,
so no request leaves the machine, and a process tree that ends as a whole when
the run does, however it ends. The folder is removed after a green run and
kept, with its path printed, after a failed one or with `--keep`. Linux with
unprivileged user namespaces is needed for the namespaces; `--allow-network`
runs without them (still no credentials and the same provider check, traffic
not blocked). Dependencies are installed before the network is cut.

## Checks on another machine

```bash
scripts/remote-verify.sh --host build-box                        # the commit at HEAD
scripts/remote-verify.sh --host build-box --e2e test/e2e/chat.spec.ts   # and a browser spec
scripts/remote-verify.sh --host build-box --only unit,cli COMMIT # some stages of another commit
```

`--host` is any name `ssh` reaches (or set `KEEL_VERIFY_HOST`). The host needs
git, Bun and an account; nothing else of this machine is used or copied there:
no credentials, no config, no state. The commit is pushed to a bare repository
under `~/.cache/keel-verify` on the host (`--dir` names another folder) and
checked out in a folder of its own, where its packages are installed from the
lockfile. Then the typecheck, the unit suite, the page's library tests, the
scripts' tests and the command line e2e run one after another at a low
priority, each with a clean environment: a home, a temporary folder and a
config folder of the run's own, no credential helper, no memory store, no
keyring. `--e2e` adds the named browser specs through `scripts/smoke.sh`.

Each stage says how it went as it ends, and a table closes the run:

```
stage       exit   pass   fail  seconds
install        0      -      -        1
typecheck      0      -      -        2
unit           0   1050      0      133
ui             0     59      0        0
scripts        0     10      0        7
cli            0     31      0       93
```

The logs stay on the host and are copied back (`--out DIR`). The command exits
0 when every stage passed, 1 when one failed, 2 when it refused to start (a
tree with changes that are not committed, no host, a tool missing there) and 3
when the host is busy: at most two runs are on a host at once (a third waits,
`--wait SECONDS`), and none starts when its load is over 20. A commit's folder
and a run's logs are kept on the host for a day. Stopping the command stops
the run on the host.

A second machine is also the check that nothing assumes the first: the test
files of a run share one process and run in the folder's order on the disk,
which differs from one machine to the next.

## Automatic diagnostic notices

Off by default. To opt in, open a dedicated coordinator session, copy its ID
from its session URL, and set `KEEL_DIAGNOSTIC_SESSION=<session-id>` in the
`keel serve` process environment on its next launch. Unset it to stop sending
new notices. No additional model is configured: a notice starts a normal turn
on the destination's selected model, at its usual cost.

Keel groups new captured daemon, tool and provider failures by their
Errors ID. Each notice lists at most eight groups, with occurrence counts and
an overflow count. Keel waits at least ten seconds to batch a notice and sends
at most one per minute. It remembers up to 512 reported IDs in memory, so a
repeating error does not start another turn. Marking the error resolved lets
a later occurrence start a new incident. Browser reports stay in Errors and
never start a turn. Provider attempts with an automatic retry or known
in-place recovery also stay in Errors; a captured failure after retries are
exhausted can trigger a notice. This covers captured errors, not every tool
refusal or unsuccessful turn outcome.

Only fixed category labels, counts and opaque Errors IDs are sent. No error
message, stack, request, session title, source session ID or transcript is copied.
Errors attributed to the coordinator or its subagents are not fed back to it.
Notices wait until the destination is idle, its queue is empty and not held,
and any parked turn has had its chance to recover.
The destination must be a local, unarchived top-level session with a workspace
and incoming messages enabled. There is no fallback destination.

Delivery is best effort. Undelivered batches and the remembered IDs are
discarded on shutdown or reload. Old errors are not replayed, but new captures
can notify again; the Errors panel remains the record. A notice already written
to the coordinator's transcript is part of its normal session history and that
turn follows the usual restart behavior.

## Failures in a session's own work

A session is told what went wrong in its own scope without asking: its agents,
their tools and its own turns. Keel keeps one row per cause (the kind of
failure, its class and its first lines, with numbers, ids and paths folded) and
sends what the session has not seen yet as one harness input, built from the
table with no model call. Ten agents that failed on the same provider error
arrive as one entry with the error once and each agent's id, not as ten
reports. Folding can merge failures that differ only in a number or a path, so
an entry shows the first one.

- An agent that failed and wrote nothing of its own is told in the notice
  instead of in a report. That starts a turn, as the report would have. An
  agent that wrote something, left work in its worktree, or failed after its
  cause already named twenty agents still waiting to be told, reports normally.
- Everything else never starts a turn. It goes with the next input the harness
  delivers to the session (a report, a wake, a loop run), never with a message
  the owner types: a tool failure that one agent repeated three times or more
  since it was last told, and a turn of the session itself that ended on an
  error (dropped once a later turn gets through).
- A cause appears once per notice. If it happens again later, the next notice
  says how many more and the total.
- A session whose queue is held after the owner's Stop is not started by a
  notice. The notice goes after the owner's next turn.
- What is owed is in the table, so a notice owed when the daemon stops is sent
  once after it starts.
- Text is redacted like everything stored, an entry holds at most three lines
  and twenty ids, and a notice at most eight causes; more causes go with the
  next notice.
- A tool failure gets no line when the agent's own report is in the same
  input, and an input says once how many agents still run.
- A wait that returned an agent's report clears the failure that stood in for
  that report only. An earlier task's failure of the same agent is still told.
- Counted but never sent: the session's own tool failures (it has their
  results), the failures of a reviewer or verifier agent (their results never
  enter the conversation), failed model requests (retried ones too), timed out
  waits and a loop's failed run (the turn's own failure is what is told).

The same rows are read at `GET /api/errors?session=<id>` (`failures`, the
newest 200 causes), with the Errors rows that last happened in that session or
its agents. For an agent's session it returns the rows of its parent that name
it.

## Backups

`keel backup` writes a checked copy under `<state>/backups`: the database, the
settings files, the uploaded files, and the files of the config folder (MCP
servers, hooks, skills, plugins, agents, instructions). The daemon makes one
before a restart. `keel backups` lists them.

A backup is made in a worker, so the daemon keeps answering meanwhile. The
database is kept compressed (`keel.db.zst`, which `zstd -d` reads too). When
few pages changed since the newest full backup, a backup holds only those
pages (`keel.db.delta.zst`) and names that full backup; `keel restore` reads
both. A delta is taken while the changed pages are at most one in `keep`
(the number of backups kept, 5 by default), so the deltas beside a full
backup never outweigh a second one. A full backup stays for as long as a
kept backup is read over it. Each backup records the SHA-256 of the
database it restores to, and a restore checks it.

What a backup was checked for before it got its name:

- A full backup: SQLite's integrity check passed on the snapshot that was
  read, and the file was read back whole to the recorded SHA-256.
- A delta: every page that differs from its full backup is in it, read from
  one snapshot; the delta was read back and each page matches; its full
  backup's file has the SHA-256 it was written with. It is not read back
  whole and SQLite's check is not run then: both take time in proportion to
  the store, and a restart waits on its backup.
- The daemon does both after, in a process of its own: twenty seconds after
  a start that finds such backups, and right after a backup that was asked
  for. It runs the integrity check on the store and reads each such delta
  back whole. The list says "pages checked" until then. A restart that is
  asked for meanwhile ends the check, which keeps what it found and runs
  again after the restart.
- A delta that does not read back is marked, and its full backup with it
  when that is what is damaged. Nothing more is built on that full backup,
  and a full backup is made at once. A store that fails the integrity check
  marks every delta of that check instead: none is called whole, and a full
  backup of it is refused. Either is reported in Errors once.
- The list names the newest backup known whole.

Every file a backup writes is synced to disk, then its folder, before the
folder gets its name; a restore syncs what it writes and its renames.

Config files are copied at their own mode into folders only the owner can
open. A file that did not change since the last backup is shared with that
backup, not copied again. Left out: links, `.prev` and temp files, folders
whose name starts with a dot, `node_modules`, and the sign-in file. A file
that cannot be read is skipped and named in the backup's `manifest.json`. It
never fails the backup.

`keel restore BACKUP` puts the state back. The daemon must be stopped. The
files it replaced stay beside the state. The config folder is left alone
unless asked for, because the state folder does not say which config folder
goes with it:

- `--config` puts the backup's config files into this shell's config folder,
  when that is the folder the backup was made from.
- `--config=DIR` puts them into `DIR`.

Each file put back keeps what it held as `<name>.prev`, and keeps its mode. A
file the backup does not hold stays as it is. A keel from before backups
carried config refuses such a backup and says why. The state is untouched.

A backup does not hold workspace files, the rest of the state folder, or
sign-ins and provider credentials. The steps for backup, drain, restore and
restart, how to undo a restore, and a restore to try on a scratch folder are
in [docs/backup-and-restore.md](docs/backup-and-restore.md).

## Retention

Two things only grow: spilled tool output under `<state>/spill` (long
results, command logs, fetched pages) and the usage records (one row per
model call and per tool call). Nothing is removed until a retention is set:
both are never (0) by default. Settings, Storage proposes 30 days for
spilled output and 365 days for usage records, says what they would list
now, and sets them when accepted.

- Spilled output goes by its session's last use, not the file's age. A
  session used yesterday keeps every file. A pinned session, one with a
  running turn and one with a live command keep theirs.
- Usage records of the running month are never removed, whatever the
  setting: the monthly spend limit is counted from them.
- The page lists what is past the settings and when the daily cleanup next
  runs. A changed setting waits a day before the cleanup acts on it.
- "Remove now" asks first and removes only the sessions and times that
  were listed. `keel cleanup --retention` prints the same list; with
  `--yes` it removes it.
- A removed output is written down in its session's spill folder. A model
  that reads the file again is told the retention removed it and to run
  the command again. The transcript row and the Terminal panel say the
  same, and a command stays in the Terminal panel's list.

## Desktop app

`desktop/` is Keel in a window of its own: a small native program around the
daemon's page, with a tray mark that counts what waits on you, native
notifications whose click opens the session, and `keel://` links. It follows
the daemon across restarts and never stops it. Build it with
`desktop/build.sh`; see [desktop/README.md](desktop/README.md).

## Phone

`android/` holds Keel for Android: sessions, approvals, questions and push on
the phone, paired with a one-time `keel://pair` code from Settings, then Phone.
See `android/README.md`.

## Approvals away from the page

An approval is given only for text that was shown, whatever answers it. The
daemon holds that rule, not one client. Every client reads a request in one
form (`GET /api/sessions/:id/approvals/:aid`, `src/safety/card.ts`): the whole
text to judge (the command, the paths and what an edit writes, a tool's input,
up to 20,000 characters, with `cut` when that is only the start), what in it
can mislead (hidden characters, letters written right to left, letters that
pass for plain ones), its risk, where it runs (the machine, the folder a
command starts in, the shell when it is not the default) and why it is asked.

A request that one line shows whole is allowed from anywhere: at most 160
printable ASCII characters, no tab, low risk, nothing cut, run in the
session's own folder on the session's machine with the default shell. Any
other is held: an allow of it is taken only with the client's word that it
showed all of the text (`seen: "whole"`), and is otherwise answered `409` with
a sentence to show ("Open the request to read it first: it is 41 lines
long."), while the card stays open. A deny is taken from anywhere at once.

A standing answer ("for this session", "always") stores a rule, and every
client names that rule where it offers the answer: "Allow echo * for this
session". The rule covers later calls. Of the requests that wait beside it, it
settles the ones a line shows whole; a held one stays open for its own answer,
whatever rule was made after it opened. A change of mode still settles every
card: that is the owner's word about every call.

- The page sends the word when its own card was read.
- The phone app shows the whole text and sends it once the text was scrolled
  to its end. An app from before the rule gets the sentence.
- A notification shows a line, and collapsed only its start. It carries Allow
  once only for a request whose whole line (the tool and the text) fits in 40
  characters of plain ASCII with no run of spaces, and Open and Deny for the
  rest. The line names a folder under the session's when the command starts
  there, and a tool's name is written in it with nothing hidden. The policy's
  answer counts too: only a low-risk request, and none whose rule the policy
  classes as what destroys, reaches a remote or another machine, exposes
  something or hides what it does. Its action never gives a standing answer. The app draws the whole line again
  before it asks for the fingerprint.
- `keel approve ID` shows the request (through the pager when it is taller
  than the terminal) and then asks. `--yes` skips the question for a request
  one line shows whole; any other needs `--yes --seen`. With several open it
  lists them and asks which, and without a terminal it lists and exits 2.
  `keel attach` prints each request whole when it opens; `/approve` answers
  the one it printed, a held one by its id, and on a pipe no held one at all.
- An editor over ACP is sent the whole text in the request's content, with
  hidden characters written out, as are the title and the rule an "Always
  allow" option names. `rawInput` is the tool's input as it is, for the
  editor's own use: it is not what is shown to be read. A script over a run's
  stream is handed the whole input.
- A card of a session on another machine is judged by the daemon that owns
  the session; the forwarding daemon passes the word through and adds none.

An answer that comes second is told who answered first and how long ago
("already allowed (once) from the page, 3 s ago").

The answer keeps who gave it: the kind of client, the phone's name, the
machine it came through, whether the text was said to be shown (given, for a
script and an editor), and for a card a standing answer settled, whose rule
it was. The timeline, a trace's wait and the activity list say it ("allowed
once from the phone").

## Memory observability

`GET /api/integrations/tacit/stats` reports in-memory totals since `since_ms`
(reset on restart or reload). Each hook records completed outcomes and total
and maximum elapsed milliseconds, separate from transcript rebuild time.
`hit` means the hook supplied context, not that it was relevant. `empty` means
it succeeded without context, and `ok` means pre-compaction succeeded without
requesting context. `timeout` and `failure` are counted separately.

Context bytes count UTF-8 text after Keel's cap, before its memory wrapper.
Transcript metrics count reused versions, appends (a branch that only grew
gets its new events appended), rebuilds, failures, files removed with their
session, elapsed milliseconds, and bytes written. Reuse writes no bytes.
Each hook also counts `late`: calls that did not answer within the hook's
wait. `tools` counts tool calls the store was not asked about
(`never_answered`: a call it answers with nothing whatever it holds),
`not_held`: results of reads not held for an answer that had not come, and
`request_waits` with `request_wait_ms`: requests that waited for such an
answer, and how long in all. `degraded` says which kinds of call had a
quarter of their last 20 answers late.
`processes` counts hook processes: the most alive at once and their limit,
calls not made because one of the same session and hook was still out
unanswered, and probes. `owed_dropped` counts lines dropped because more was
waiting for a session than may wait. `out` names the kinds of call (asking,
tool) the store is not answering in time right now.
The endpoint includes no prompts, transcripts, facts, or session identifiers.
Poll it and compare counter deltas to track changes over time.

What to look at on the first day with a real store: `hooks["session-start"]`
in that report. A session's start call makes the store sync its clone, and
the first request of every new session waits for it up to 6 s.
`duration_ms.max` says how long the slowest start took (over 6,000 means a
first request went without the start block, which then followed late).
`outcomes.timeout` counts starts that ran into the store's own 15 s hook
timeout and were ended there. `context_bytes.max` is the largest start block
a session was given.

The store gives a session each fact once, so a fact it printed always reaches
the model: a block holds at most one hook's cap in whole lines (a longer line
goes in parts), and the lines it had no room for are kept in the state and
follow with the turn's next request or the next prompt. What may wait for a
session is ten blocks' worth; past it a line says how many were dropped.
A turn waits for a call only so long (6 s for a start block, 2.2 s for a
prompt, 0.9 s for a tool call), and no store process is ended before the
store's own 15 s hook timeout: what it answers after the turn went on follows
like a line that did not fit. One call a turn stopped waiting for is a late
call, counted and no more (a loaded machine makes one slow). Two of a kind in
a row are an outage of that kind: an error is recorded, the session is told
once, later calls of that kind are made but not waited for, and a probe that
asks the store nothing ends the outage when it answers within the wait again.
The probe is asked only while calls of that kind are being made. After a
summary or a clear the store is told, so what it gave before can come again;
what was owed from before a clear is not carried into the fresh context.

Before a tool the store is asked, and a rule it gives is in the request the
model answers by acting. Only a call it never answers is not asked about: an
edit of a file in no checkout (by the file's real path) and an empty
command. Nothing in the store's answer says when the store last changed, so
an empty answer is never remembered: every other call is asked every time.
A call that changes something (an edit, a write, a shell command the
permission gate does not read as read-only, an MCP tool its server does not
call read-only) has its result held for the answer, so the rule is in that
result. A read's result is not held: the session's next request waits for
the answer (what is left of the hook's wait), so a rule that came with a
read is there before the model acts on what it read. Each such answer gets
a block of its own in that request's note. Calls the store records as steps
in themselves (its own tools, its command line in a shell) are always
passed to it. A store that is late now and then without ever missing twice
in a row is said once per session ("Memory is answering slowly") while a
quarter of its last 20 answers of a kind were late.

`GET /api/telemetry/memory?since_ms=&until_ms=&session_id=` reports what memory
cost the turns and whether they used it, kept across restarts for 90 days: per
recall path (the memory store's blocks at a session's start, with a prompt,
with a tool call and carried to a later step; the helper's records) how often
it was asked and how that ended, the facts and tokens it added, the facts the
turn's reply or tool calls named (an estimate that reads low: a fact can shape
a reply without being named), the lines not added again because the context
held them, the lines carried to a later step, and the time turns waited;
and under `store`, the kinds of call the store is not answering in time or
answers slowly right now. Counts, tokens and times only. Settings, then Usage, shows it as the Memory
panel.

The Memory panel also shows the facts themselves (Settings, then Usage, the
Memory view; `/memory` in a session, or the memory chip of a turn, opens it on
that session). Given: what a session was told to remember, moment by moment
(its start, a prompt, a tool call, a compaction), with the facts each moment
handed over, what they cost and whether the turn named them afterwards
(`GET /api/memory/given?session_id=&before=`, forty rows a part). Keel keeps
the names and ids only, and only names of the store's own shape; the rows go
with their session, a part at a time. A fact's text is read from the store
when it is opened
(`GET /api/memory/fact?name=`). Search: the store's own search, in its order,
with its score (`GET /api/memory/search?q=`). Never named: per fact, how often
it was given and whether the turn named it afterwards, the never named first,
with the tokens memory added per session and per day and the share of the
store's calls that came late or with nothing
(`GET /api/memory/efficiency?since_ms=&session_id=`). Named afterwards is a
rough signal that reads low: the fact's name, three of its words in a row
that are not all common ones, or a path, file, flag or quoted command it
names, in the model's later text or tool input of that turn.

Every change goes through the store's own commands. A correction is sent as
the store takes one, a newer note for its curator (`tacit add`), in two
requests to `POST /api/memory/correct`: the first sends nothing and answers
with the command and a one-time id; the second names the id and runs that
command as it was shown, once, within two minutes. The dialog that asks
opens on Cancel and shows the command and the writer the store will record
the note under (the store has no writer for Keel: Settings, Memory and
supervisor, names one of the store's own; `TACIT_HARNESS` overrides it). A
sent correction is
listed in the session's activity by the fact's name and the note's path,
never its words. The store keeps editing a fact in place and retiring one
to its own page for the owner (`tacit review --fact NAME`): Keel shows that
command and runs nothing. A store that is missing, slow or failing is said
in the panel; a read of it is waited for eight seconds at most and never
holds a turn.

`bun scripts/bench/memory.ts` measures the same on generated data, with a
stand-in store and a scripted model: tokens added per turn, facts used,
repeats, facts the store gave that never reached a request (this must be 0),
the cache prefix, time before the first request, a store that is slow or
failing, and whether the helper recalls the record a prompt is about.

## Scripts: a session held open

`keel run -p PROMPT` prints one answer. `keel run --input-format stream-json` keeps one session
open for a script: prompts, an interrupt and answers to permission requests go in as JSON lines
on standard input, and the session's events and one result per turn come out as JSON lines. A
request the permission mode asks about is refused unless the script answers it (`--on-ask stdin`).
[docs/headless.md](docs/headless.md) has the lines and the exit codes;
[docs/http-api.md](docs/http-api.md) lists the HTTP routes the command uses, which are stable.

## License

MIT
