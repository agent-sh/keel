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

### Provider outages

A captive portal is not a provider answer. An HTML sign-in page or redirect
keeps the turn waiting. A normal API 401 is still a credential error for the
request that got it, not a recovery signal for other turns.

A turn waiting on a provider gets the shared quick checks, then a check every
five seconds for the first ten minutes. A return to the same outage schedule
within five minutes keeps its backoff. A long outage raises one notification
after five minutes. The wait is separate from work time in the timeline and
receipts. Only requests sent during an open outage use the ten-second header
check. A request cut by that check spends a counted attempt because it might
have reached the model. Other requests keep the provider's own idle limit.

### A local broker that changes ports

If the launcher reads the broker address from an environment file, set
`KEEL_PROVIDER_ENV_FILE` to the absolute path of that same trusted file. For
systemd, set it with `Environment=` alongside `EnvironmentFile=`. Keel does not
look up the unit or source the file as a script.

After a loopback connection refusal, the provider's shared outage probe can
reread that provider's base URL, at most once every five seconds per provider.
It accepts a new port only; the scheme, host and path must stay the same. The
file must contain simple single-line assignments; replace it atomically when
updating the port. Keel does not reload keys or other settings. On the first successful answer from the new port, it records
the move in the daemon log and marks it recovered in Errors.

This applies to the HTTP APIs configured with `ANTHROPIC_BASE_URL`,
`ANTHROPIC_BEDROCK_BASE_URL`, `OPENAI_BASE_URL`, `GEMINI_BASE_URL`,
`KEEL_CODEX_BASE_URL`, or `KEEL_XAI_PLAN_BASE_URL`. Reloadable brokers use
HTTP without redirects. If the service uses a proxy, add the loopback host
(without a port) to `NO_PROXY`. Remote defaults are unchanged.

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
| Nothing runs and something it set up starts the next turn, or its turn waits for a provider that cannot be reached | Waiting | for a timer, a file, a log line, an HTTP check, a process, a monitor, a pull request's checks, another session, an agent, the provider |
| A restart cut the turn and Keel goes on with it | Waiting | to resume |
| A message you sent that its session has not taken yet | Queued | held until its current step ends, until its turn ends, or until it is resumed |
| Its last turn ended | Done | |
| Its last turn failed | Failed | one class: rate limit, overloaded, server error, stream dropped, provider unreachable, context full, sign-in, billing, image refused, invalid request, output limit |
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
escalation and other owner-only actions still ask. What the judge is sent of
a high-risk action is its first 4,000 characters, so a longer one (a command,
a list of files, a tool's input) is refused instead of run partly unread;
Reviewer mode sends such an action to you. **Full auto** checks nothing: every
call runs without review, high-risk ones too, and no judge is asked; the
activity list names each call the rules flagged as "ran unreviewed". A
sandbox, if the session has one, still confines its commands, and its file
tools the same way: they read what its commands can read and write where
its commands can write. That is containment you turned on, not a check of
the work. One refusal holds in every mode, Full auto too: no session's tool
writes Keel's own state folder, which keeps a session from corrupting the
store of the daemon it runs in. Tools that
explicitly require confirmation still ask in both modes.
**Auto edits** still asks about ordinary work outside its safe defaults.

[Claude Code](https://code.claude.com/docs/en/permission-modes) separates
classifier-backed `auto` from `acceptEdits` and `bypassPermissions`. Keel
imports those as Auto, Auto edits and Full auto, respectively.
[Codex](https://developers.openai.com/codex/agent-approvals-security) treats
sandboxing separately from approvals and can review eligible approvals
automatically. [OpenCode](https://opencode.ai/docs/permissions/) uses
`allow`, `ask` and `deny` rules scoped by action and resource.

## What makes a command high risk

A command is high risk when what it runs is in one of five classes. Such a
command gets a card of its own in Ask, Auto edits and Reviewer, also under a
sandbox, goes to the judge in Auto, and runs unreviewed in Full auto. No standing rule covers
it, and the card says which rule of yours it overrode. The class is on the
card and in the `PermissionRequest` hook's `keel_rule`.

| Class | What it reads |
| --- | --- |
| destroys work or data | a delete, move or overwrite outside the session's folder; a delete inside it of files git cannot bring back; git's ways to discard work; a drop or reset of a database that is not local or a test one |
| changes another machine or a service | a classed command sent to another machine or a container (`ssh`, `kubectl exec`, `docker exec`, `mosh`, `ansible`), a deploy or publish, a delete on a cluster, a cloud or a hosted service |
| sends credentials out | an environment file, a key or a credential store handed to a program that sends: by name, through a substitution, a variable, a copy, a redirect, or the folder sent whole |
| runs code that is not in the command | a program word the line builds, a script fetched and run, text decoded or handed over on input, an install from an address or a registry the command names |
| reaches past the session on this machine | signals to runtimes or to Keel, scheduled work, system services, a container given the host |

The classes read the command's words. They ask the disk four things, off the
loop and before the decision: what git cannot bring back under a path, whether
a path outside the folder exists, which files a patch or an archive writes,
and what a file of SQL says. A question the disk does not answer in time is
read as high risk.

In a sandboxed session a write outside the session's folder fails by itself.
A command is not asked about only for naming such a path: a delete, a move or
an overwrite there, or a write to another project's file that runs later
(another repository's hooks, a workflow file next door). That holds when the
path is the one the kernel reaches: written out from the root or the home with
no step back up, or relative to a folder that is certain (not after a `cd`
that may have failed), and not under `/proc`, `/dev` or `/sys`. The classes
still decide what the sandbox does not stop: the session's own folder and its
repository's data, a temporary folder emptied whole, another machine, a send
of credentials, a publish, a command handed to a service manager, a container,
another terminal or another root, and the user's own configuration (start
files, login keys, the home folder's own tool settings).

One decision has budgets. A line past one of them is not read further: it is
high risk, and the card says the number.

| Budget | Limit |
| --- | --- |
| commands on one line (the lines of a here-document are text) | 4,096 |
| scripts nested in scripts | 8 deep |
| a nested script, or a here-document fed to a shell | 4,000 characters |
| paths one command writes or deletes | 1,024 |
| questions to the disk for one command | 32 |
| a folder followed through a chain of `cd` | 4,096 characters |

### What the classes do not read

The classes are a reading of the command line, not a wall. The sandbox and
the judge are what hold a command the reading misses. Known gaps:

- What a script file of the session's own does (`bash run.sh`, `make`,
  `npm run x`): only its name is read, and a name with `deploy` or `publish`
  in it is high risk.
- Code handed to an interpreter beyond the forms listed in `src/safety/risk.ts`
  (deletes and write-opens with a path written out, a fetch that is run, a
  credential file read beside a network call).
- Mass edits that empty files (`sed -i 'd' src/*.ts`): not told from a codemod.
- A token in a request's own words (`curl -H "Authorization: Bearer $TOKEN"`):
  the rules cannot tell the host that owns the token from another.
- `git add -A && git push`: what `-A` adds is not in the command.
- Cloud runners that carry a command in a document or a parameter
  (`aws ssm send-command`), and services whose verbs are not in the tables.
- `kubectl create secret --from-env-file`, a copy of a credential file to a
  mounted share, an archive unpacked or a sync into an existing folder
  outside the session's, `gzip` or `chmod` of a file there.
- Temporary and cache folders: a move or an overwrite there is not counted
  as a loss.
- A file server with no bind address given (`python3 -m http.server`); the
  form that names every interface is high risk.
- A database client's host given only by its own config file or by a
  variable set outside the command, for clients that read one.
- A file git ignores that is deleted with its folder (an ignored `.env`).

## The command sandbox

With a session's sandbox on (workspace-write), a command runs in
[bubblewrap](https://github.com/containers/bubblewrap): it writes only in the
session's folder, its own temporary folder and the session's own scratch, it
reads the system and your toolchains but not the rest of your home folder,
and it has a network of its own (below).

### What a sandboxed command can read

A sandboxed command runs without a card in Auto edits, Auto and Full auto,
so what it can read it can pass on to any public host when the session's
network is on. It reads, by design:

- the session's folder, `.env` files in it included (the task may need
  them: keep a secret out of a folder you let a sandboxed session work in);
- the other checkouts of the same repository (the main checkout and its
  worktrees), read-only. A checkout counts when it and the repository name
  each other: its own `.git` file points back at the repository's entry for
  it. An entry a command wrote into the git directory shows nothing. Of
  the worktrees Keel made, a session sees its own agents', not another
  session's;
- the system: `/usr`, `/etc`, `/opt` and the like, as unix permissions allow;
- your toolchains, read-only: the well-known folders (the `bin` folders of
  cargo, bun, go and `~/.local`, `~/.rustup`, `~/.nvm` and their kin), the
  folders the toolchain variables name (`CARGO_HOME`, `GOROOT`, `JAVA_HOME`
  and so on), every folder on the daemon's `PATH` with the toolchain around
  it, and what the links in those folders point at. For a dot-folder
  directly in your home (`~/.tool/bin`), only `bin` and the folders named
  `lib`, `lib64`, `libexec`, `share` and `include` beside it;
- git's global config and the ignore and attributes files it names, and
  version files (`.tool-versions`, `.nvmrc`);
- your package caches, as they are: cargo's registry, the Go module cache,
  bun's, npm's, pnpm's, uv's, pip's, Playwright's browsers and the like
  (`CACHES` and `XDG_CACHES` in `src/safety/sandbox-view.ts`). A build of
  what you fetched before works with the network off;
- the registry lines of your package managers' settings (npm's, pip's,
  bun's and uv's), without their tokens: with the registry setting gone, a
  private package's name would be asked of the public registry. Without
  its token your private registry refuses, which is said;
- the skills and commands Keel offers the session, the files you attached
  to it and its artifacts folder (which its commands also write);
- for a program you configured to run in the session's sandbox (an ACP
  agent, a language server of your own or one found on `PATH`): the program
  with the toolchain around it and the files and folders its command line
  names. A command an editor passes (its MCP servers) and a program inside
  the workspace get nothing added.

Everything else is not there. The home folder a command sees is an empty
folder in memory with the above bound into it, read-only except
`~/.keel-sandbox`, where the XDG cache and state folders point
(`XDG_CACHE_HOME`, `XDG_STATE_HOME`). Your keys and cloud sign-ins, the
tokens of command line tools, browser profiles, the keyring, shell history
and startup files, editors' and other harnesses' folders, other projects,
`~/.cache` (apart from the package caches), `/root`, `/mnt`, `/media` and
data disks are not readable (`CREDENTIALS` in `src/safety/sandbox-view.ts`
lists the stores by name), and neither are the sockets under `/run`: the
session bus, the keyring, the GPG and SSH agents, the display, Docker.
Keel's own state and config folders (every session's text, the API token,
device keys, your settings) are hidden in every sandbox, whatever you list.

Three rules hold whatever names a path:

- Nothing inside a credential store or one of Keel's own folders is shown
  because a link, a toolchain variable or git's config points there. Only
  your own list opens a store, by naming it.
- After everything is bound, the stores and Keel's folders are hidden
  inside whatever was bound (a folder you listed, the session's folder, a
  toolchain).
- Nothing is followed from a folder the sandbox can write. A `PATH` folder
  inside the session's folder (an activated `.venv/bin`, `node_modules/.bin`)
  is the session's own, and a link in it points where a command made it
  point: its target is not shown.

What a command writes to a package cache lands in a layer of the sandbox's
own, on disk in Keel's state folder, and nothing outside a sandbox reads it:
a sandboxed command cannot plant a package for a later build of yours. A
command that runs alone always gets the repository's first layer, so the
next command finds what it fetched. Commands that run at the same time each
get a layer of their own (the kernel does not allow two mounts over one):
what the second fetched is found again when two run at once again, else it
is fetched again. Where you have no cache folder yet for an installed tool,
the tool's folder is the sandbox's own. Temp files of a sandbox are removed
after 10 days and a layer no command used after 30 (systemd's defaults for
`/tmp` and `/var/tmp`); Settings shows what the sandboxes hold on disk and
clears it. What is removed is first moved out of the sandbox's reach by its
name and removed there, so a link a command left in its temp folder is
removed as a link and nothing it points at is touched.

A repository's sandbox takes 64 commands at once, and one session 16 of
them. A command past either waits 20 seconds for one to end, and then ends
with the sentence that says which bound it met.

A sandboxed command's environment holds what a build needs (`PATH`, the
locale, the temp folder, the toolchains' variables, the proxy variables the
sandbox sets) and nothing else of the daemon's: no variable whose name says
token, key, secret, password or credential. A kept variable whose value is
a URL with a sign-in (a password, or a token alone, as in `GOPROXY` or
`PIP_INDEX_URL`) goes in without the sign-in, so the registry setting stays
and the token does not. git settings given through the environment
(`GIT_CONFIG_COUNT` and its pairs) all go when one of them carries a
sign-in, an Authorization header among them. A kept variable whose value
carries a sign-in that is not a URL's own goes whole: a header, a token in
a URL's query, a netrc line, a field of JSON, a flag that sets one (what a
value hides by encoding it cannot be told). The environment is cleaned
before bubblewrap starts: bubblewrap is the first process inside, and what
it was started with can be read there. You can name more variables to pass
on in Settings; a variable a tool adds for one call (a secret you gave the
session under a name) is passed as it is.

What that costs a command, measured on a day of ordinary work (bun, npm,
pnpm, cargo, go, uv, pip, git, make, cmake, curl, java all work):

- git over SSH, and `ssh` itself: there is no key and no agent. Turn on
  "Let its commands use the SSH agent" for the folder: the commands can
  then sign in with your keys while it is on, and still cannot read them.
- git over HTTPS to a private repository, `gh`, publishing a package, cloud
  command lines, a signed commit: their tokens and keys are not there. For
  a token kept in a file, add the file or folder to what the session's
  folder may read. A token kept in the keyring (`gh` and git's credential
  helpers on a desktop) is reached only outside the sandbox.
- `docker`: its socket is not there (a container can read the whole
  machine). Run it outside the sandbox.
- A write in the home outside the session's folder fails, as it did before,
  `~/.cache` included.
- A tool whose settings file is hidden may behave differently (another
  registry, no sign-in). Settings lists the hidden settings files you have.

A command that looked for something hidden is told what was hidden and how
you allow it; for a credential store or one of Keel's own files no way
around is offered. The sentence is the same whether the path exists or not.
You see and edit the lists in Settings, Permissions, "Sandbox: what commands
can read": folders and files for every session, for the sessions of one
folder (a repository's checkouts count as one), the SSH agent switch for
one folder, and the variables to pass on. The list is in Keel's config
folder (`sandbox.json`). A list cannot name the whole home folder, the
machine's runtime folders (`/run`, `/proc`, `/tmp`) or one of Keel's own
files, judged where the entry really is (a link to the home is the home).

Where the kernel or bubblewrap cannot mount an overlay inside the sandbox
(a kernel before 5.11, bubblewrap before 0.11), the package caches are the
sandbox's own, empty at first: a first build downloads again.

### The file tools

The file tools (Read, Grep, Glob, Edit, Write and their kin in each family)
run in the daemon, outside the sandbox. In a sandboxed session they are
held to the sandbox by the same rule:

- A read of what the sandbox shows runs. A read of anything else asks you,
  in every asking mode. Full auto asks nobody, and the sandbox still holds
  there: such a read is refused, as a command's would fail. The credential
  stores and Keel's own files are judged before the session's folder: a
  session whose folder is your home asks for your keys all the same. Other
  sessions' outputs, artifacts and attachments are closed to a session.
- In Full auto a write lands only where the session's commands can write:
  its folder (the repository's own `.git` aside) and its scratch, by where
  the file really is. Keel's config folder is outside that, so a sandboxed
  Full auto session does not write it. A file of the folder that runs later
  (a CI workflow, the project's hooks file) is written like any other: the
  session's commands can write it too. A file that has another name
  elsewhere (a hard link) is not written; in the asking modes it is your
  card.
- A reading tool Keel knows only by its flag (an MCP server's, an ACP
  agent's) is judged by the files its input names, the same way: its path
  keys, and every string anywhere in the input that is a path or a `file:`
  URL by itself. One that names no file at all runs outside the sandbox and
  reads where it chooses: you are asked once and the answer stands for the
  tool. In Full auto it runs, as every tool that is not a file tool does
  there: no sandbox holds such a tool.

A path is judged where it is, and what is judged is what is opened:

- Where a path leads is the kernel's walk, never the path's text: each part
  in turn, a link followed where it stands, `..` applied to where the walk
  is. `<folder>/link/../file` is beside the link's target. A path the
  kernel refuses (too many links, a part after a file, `..` after a part
  that is not there) is not opened.
- A name is a name whatever characters it holds: a link called `l[x` is a
  link. Only a pattern (Glob's, Grep's) is read up to its first wildcard.
- The gate looks, then the tool opens, and a command running beside the
  call can change what a name is in between. So after the gate's look a
  file tool does no I/O on a name. It opens the folder the gate judged by
  descriptor and checks that what it opened is that folder; takes a bare
  handle on the file inside it that follows no link (or creates the file
  there and only there); reads what the handle is from the handle; and
  reads and writes through the handle's own path. Refused, with "not the
  file this call was checked for": a name that became a link, a folder that
  became one, a file that is not the one the gate saw under that name
  (another file's hard link moved there). A folder a write has to make is
  made one step at a time under the deepest folder that exists, each step
  inside a held descriptor. Glob and the readers list a folder from its
  handle the same way.
- A named pipe, a socket or a device at the name is not a file: nothing is
  read from it or written to it, and the tool says what it is. Opening one
  can hang a call, so none is opened.
- A file that is a hard link when the gate looks (it has another name
  somewhere) is a file of the folder it is in: a read of it runs, as a
  command's would, and a write of it in a sandboxed session is your card.
  Package managers that link files from a store make many such files.
- The folder a session was made in is pinned. If its name leads somewhere
  else later, or it is another folder under the same name, nothing runs in
  that session: every rule here is about "the session's folder". A sandboxed
  command cannot do this to its own folder; a command outside a sandbox
  can. A sandboxed command checks the folder it was given against the pin
  once more inside the sandbox, before it runs, where no name can change
  any more. A worktree Keel made is pinned anew when Keel makes it again.

This needs `/proc` (Linux). Elsewhere the path is checked again right
before the open and the name's kind is read without following a link, which
narrows the gap and does not close it.

Keel's own folders have a rule each, in every mode, sandboxed or not, for
every tool and for a command's plain write, by path, through a link,
through a hard link or through `..`:

- Its state folder (the store, its logs, the API token, device keys, other
  sessions' files) is never written by a session's tool, in Full auto
  either. This is not a check of the work: it keeps a session from
  corrupting the store of the daemon it runs in, and the refusal says so.
  The session's own artifacts folder and a worktree Keel made for it are
  its own. A session you point at the state folder itself, or at a folder
  inside it, can read there and write nothing: the refusal says the
  session's own folder is Keel's, and that a session that changes files
  needs a folder of its own outside it. Such a session is not refused when
  it is made: reading Keel's logs from one is a fair use.
- Its config folder (skills, hooks, MCP servers, agents, plugins, the
  sandbox's lists, settings) is yours alone to change. A session you ask to
  write a skill or add a hook there gets your card in Ask, Auto edits and
  Auto: one call at a time, with no standing rule offered and no judge.
  Full auto checks nothing, so there the edit runs like any other, named
  in the activity list as "ran unreviewed"; with a sandbox on, the folder
  is outside what the session can write.
- A file of that configuration you keep somewhere else by a variable
  (`KEEL_HOOKS`, `KEEL_MCP_CONFIG`, `KEEL_ACP_AGENTS`, `KEEL_ACP_FOLDERS`)
  has the config folder's rule, and one more: it is never loaded from a
  folder a session works in. A command there could have written it, and
  Keel would run what it names outside any sandbox. Such a file is not
  read at all: Errors says so once, and Settings, Permissions shows it
  ("KEEL_HOOKS points inside a session's folder ... it is not loaded").
  Keep it outside the folders your sessions work in. (Where it exists it is
  also read-only in that session's sandbox, and what a command makes of a
  missing one is moved to quarantine after the call.)
- A repository's own `.keel/hooks.json` is another matter: it runs only
  while it is exactly the file you pinned, scripts included, so what a
  command writes there runs nothing until you read it and pin it again.
  Skills, agent definitions and instruction files in a folder are words
  for the model, not programs Keel runs.

These rules hold for a session's tools. A command that runs outside a
sandbox (a session with the sandbox off, or a command you let leave it) has
your own reach: what it may run is the permission modes' to decide, not the
sandbox's.

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
  `localhost`: other commands of the same call reach it, and nothing else
  on this machine does. The session's portal still shows it: the daemon
  reaches into that sandbox's network namespace for the port (`nsenter`,
  for the session's own portal only). A session's ports are those of the
  processes the daemon started for its commands and what they started,
  never of a process that names the session in its own environment. To
  open it in a browser by its own address, start the dev server outside the
  sandbox.
- One sandbox's proxy carries 256 connections at once. Past that the
  connection that has carried nothing for the longest (a minute or more)
  is ended for the new one, else the new one is refused.
- A destination is judged by its address's bytes: every way to write an
  address (hex, octal, one number, IPv6 written out, an IPv4 address inside
  an IPv6 one) is the same address.
- The proxies run on a thread of their own. If it fails it is started
  again, and that is in Errors. If it fails four times in a minute it is not
  started again: no proxy listens, nothing leaves a sandbox until the daemon
  restarts, and a command that meets it is told so. The proxies are never
  moved onto the daemon's own loop for that.

A command that the proxy refused, or that went around it, is told so in its
result. With the network off there is no proxy and nothing leaves.

Cost, measured: a command with the network on starts about 19 ms later
(the relay inside the sandbox); a request takes no measurable extra time;
the proxy and relay carry about 1.1 GB a second from a local source. The
proxies run on a thread of their own. With 50 downloads at once the
daemon's loop is delayed 0.3 ms on average and 11 ms at worst, and with 200
connections at once 0.3 ms and 19 ms (on the loop itself that was 5 ms and
27 ms, and 21 ms and 77 ms).

A sandboxed command starts about 25 ms later than one in a sandbox that
shows the whole machine (measured: 100 short commands take 61 ms each
against 34 ms). The time is bubblewrap's: it reads the machine's mount
table once for every folder it binds, and a home with many toolchains has
some 40 of them. Small settings files are not bound one by one for that
reason: they are copies in one folder, bound once.

A session in a worktree can commit. That needs git's own files to be
writable, so the profile opens them and keeps read-only what git would run
outside the sandbox later, for this checkout or another: the hooks, `config`
and `config.worktree` of the repository and of its submodules. They are kept
read-only by the folder that holds them, not by a bind of each file: git
rewrites a config by writing a new file and renaming it into place (`git
config`, `git push -u`, a new remote), and a bind of the old file no longer
covers the name after that. A read-only folder covers whatever it holds, for
as long as a command runs, so a terminal or a dev server started before such
a rewrite still cannot write the new config.

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
  Its own `config.worktree` is made empty when it is missing, so there is
  always something to keep read-only.
- A session in the main checkout gets its `.git` read-only as a whole: the
  repository's config and hooks are in it, at the top where git also writes
  the main checkout's index and `HEAD`. `git status`, `diff`, `log`, `show`,
  `blame` and `grep` work; whatever writes it fails with "Read-only file
  system": staging, commits, `restore` and `checkout -- FILE`, checkouts,
  branches, tags, stashes, fetch, merge, rebase and `git worktree add`. The
  command is told so, and that a session in a worktree of the repository
  commits: `/worktree` moves the session there with its uncommitted work.
- A submodule's git directory has its config and hooks at its top too: it is
  read-only as a whole, from the main checkout and from a worktree. Commits
  inside a submodule fail in a sandboxed session.
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
  under `info`, which is read-only there.

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

`git submodule update` of a submodule that is already checked out writes in
that submodule's git directory, which is read-only: it fails in a sandboxed
session. A first `git submodule update --init` in a linked worktree that has
no submodule yet works: the git directories it makes are the session's own
until the command ends, and read-only from the next command on.

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
- A linked worktree's own `config.worktree` is a single file in the folder
  a commit writes, kept read-only by a bind on the file. `git config
  --worktree` and `git sparse-checkout` replace it with a new file: run by
  hand in that worktree while a sandboxed command of it is still running,
  they leave that command the new file without the bind, to write until it
  ends. git reads `config.worktree` only once the repository's config, which
  stays read-only, turns per-worktree config on. The `gitdir` and
  `commondir` files beside it are rewritten in place (`git worktree repair`,
  `move`) and stay read-only. The repository's shared `config` and hooks,
  and every submodule's, have no such gap.
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
| `PermissionRequest` | An approval card is about to open | tool name | `tool_name`, `tool_input`, `keel_risk`, `keel_reason`, `keel_rule` (the class of a high-risk command, in its few words) | `decision.behavior` `deny` refuses the call. `allow` answers the card where a `PreToolUse` allow would (see below). An allow that carries `updatedInput` or `updatedPermissions` is not taken. Exit code 2 does nothing here |
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
`updatedToolOutput` and `updatedMCPToolOutput`.

Read and not acted on: `suppressOutput` (the reference says it has no
effect), and a `PreToolUse` answer of `permissionDecision: "defer"`. Claude
Code honors `defer` only in a `claude -p` run, and ignores the hook's answer in
an interactive session. A Keel session is always interactive: it lives in the
daemon and stays open to the page, also when `keel run -p` started it. So Keel
ignores the whole answer, its `updatedInput` and `additionalContext` too, and
the call goes through the usual permission check. It is never an allow. The
file's list in Settings names each hook that answered it.

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
| `command` | `command`, `timeout`, `onFailure`, `async`, `asyncRewake` | The command in bash, with the event on stdin |
| `command` with `args` | `command`, `args` | The program itself with those arguments, no shell. `${KEEL_PROJECT_DIR}` and `${CLAUDE_PROJECT_DIR}` are filled in |
| `http` | `url`, `headers`, `allowedEnvVars`, `timeout`, `onFailure` | A POST of the event as JSON. A header takes an environment variable (`$NAME`, `${NAME}`) only when `allowedEnvVars` lists it |
| `mcp_tool` | `server`, `tool`, `input`, `timeout`, `onFailure` | A tool of an MCP server Keel is connected to. `${tool_input.file_path}` in `input` is filled from the event: alone it keeps its type, inside a text it is written into it |

A command hook with `async: true` runs in the background. The event does
not wait for it, its `timeout` does not hold (the event's longest limit does:
an hour on most events), and nothing it answers has effect
(`decision`, `permissionDecision`, `continue`, `updatedInput`): what it would
have controlled has already gone on. When it ends, its `additionalContext`
and `systemMessage` reach the model with the session's next turn, not
before, as a note of that turn. Its JSON answer is all of its stdout or one
line of it; with no answer, plain stdout is read where the event reads it.
An idle session is not woken: the words wait for its next turn, stored, so a
daemon restart keeps them. A later run of the same hook replaces words not
delivered yet. `asyncRewake: true` runs the same way within its `timeout`,
and an exit code 2 wakes the session with the hook's stderr (or its stdout
when stderr is empty), stored as a message to the session like any other. A
session you stopped is not started by it: the message waits behind your
stop. A background hook still running when its session is archived or
deleted, or when the daemon stops, is stopped with every process it started.
`onFailure` does nothing on a background hook. Settings lists each
background hook in its file's notes. Both fields are read on command hooks
only.

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
| Anything in Full auto | Unchanged: everything runs, nothing is checked |
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

## Plugins

A plugin in the [Claude Code format](https://code.claude.com/docs/en/plugins-reference)
installs unchanged, as one unit: its skills, commands and agents (named
`<plugin>:<name>`), its hooks and its MCP servers come and go together.
Install from a folder, a git URL (`#branch`, tag or commit) or a GitHub
`owner/repo`; a marketplace (`.claude-plugin/marketplace.json`) lists plugins,
and one is picked from it.

```bash
keel plugin install ~/plugins/review-kit
keel plugin install https://example.com/tools.git --plugin review-kit
keel plugin list
keel plugin disable review-kit      # its hooks and servers stop, its skills, commands and agents are hidden
keel plugin update review-kit       # says what changes before it applies it
keel plugin remove review-kit
```

The same is in Settings > Plugins. Reading a plugin runs nothing. Each hook
command and each MCP server command or address it would run is shown line by
line, and nothing of it runs before a yes to those lines; an update that
changes them asks again. A copy is kept under `<config>/plugins/<id>/` by
version, with a `data/` folder that outlives updates (`${CLAUDE_PLUGIN_DATA}`),
and its record in `<config>/plugins.json`. Installing never writes your
`mcp.json`, `hooks.json` or skills. An MCP server keeps its name unless one of
yours, a built-in one or another plugin's has it; then the plugin's id goes
before it. A plugin that a repository's `.claude/settings.json` names
(`enabledPlugins`, from a marketplace in `extraKnownMarketplaces`) is offered
in Settings > Plugins for that folder and installed only when you say yes.
A plugin's settings (its manifest's `userConfig`) are given in Settings >
Plugins after it is installed: a plain value is kept in its record, a
sensitive one in the system keyring only. While a required value is missing,
its servers and hooks wait. A value reaches its MCP servers and a command
hook's `args` as `${user_config.KEY}`, its skills and agents the same way (a
sensitive one as a placeholder), and its hooks as `CLAUDE_PLUGIN_OPTION_<KEY>`;
a shell-form hook command or a headers helper that names one is not taken.
Settings > MCP servers shows a plugin's server with a sensitive value as the
`${user_config.KEY}` it was written with, and nothing Keel keeps in its state
folder holds the value.
Parts Keel has no equivalent of (output styles, LSP servers, monitors, themes,
`bin/`, MCP bundles, npm and archive sources) are named at install as not
taken, with why.

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

### What a run covers

A run of specs ends with one line that counts what ran and what did not:

```
Summary: 398 passed, 0 failed, 35 skipped (24 needs a real model; 2 sandbox unavailable; ...).
```

A skipped test is not a passed one. Each skip is made by a probe in the test
(`test.skip(condition, "needs X: why")`), and the lines above the summary name
the skipped tests under what each needs. They also name a step a test left out
because the daemon cannot show it, and what a test added to the daemon's lists
(an MCP server, a project, a paired machine) and did not take away: a spec that
fails only after another one is looked for there.

On the scripted daemon every spec passes every time or is skipped that way. To
tell a change's failures from the suite's own, run the specs it touches several
times, the files in another order each time:

```bash
bun scripts/flake.ts test/e2e/alerts.spec.ts test/e2e/search.spec.ts   # three runs through scripts/smoke.sh
bun scripts/flake.ts --runs 5 --seed 7                                  # every spec, five runs, a seed to repeat
```

It prints the tests that did not pass every time, how often each failed, and
for a flaky one the spec files that ran before it in every failing run and in
no passing one. Spec files named on the command line in another order than by
name run in the order named (`playwright.config.ts`).

### Specs that need a real model

These test what a model does with a prompt in words (it picks the tool, follows
an instruction it was given, judges a change). The scripted stand-in cannot
show that, so each is skipped on it by its own probe, with the reason below,
and runs with `KEEL_TEST_MODEL` set to a real model on a daemon that has one.
A spec whose model part is only "make this call" or "say this word" runs on the
stand-in instead (`ask(words, script)` in `test/e2e/shots.ts`).

| Spec | Test | It needs a real model because |
| --- | --- | --- |
| `agent-review.spec.ts` | reviews of an agent's work go back to that agent | it has to start an agent and act on the review |
| `agent-work.spec.ts` | agents: own worktree, structured reports, staggered starts | it has to start agents that commit in their worktrees and report |
| `code-mode.spec.ts` | code mode | it has to call run_code with the code given and repeat what it printed |
| `consult.spec.ts` | consult: the advisor tool on another model, set in Settings and per session | the advisor is a second model of the same provider, asked for an opinion |
| `context.spec.ts` | context meter, effort, compact and clear | it checks a real model's window, its efforts and what a summary kept |
| `drive.spec.ts` | sessions elsewhere: list, read, send, held while a prompt is open | it has to drive another harness's session with the fleet tools |
| `goals-tasks.spec.ts` | goals and the shared task list | it has to work toward a goal and keep the task list |
| `goals-tasks.spec.ts` | goal: a claim the files do not back is not met | the goal's verifier is a model that has to read the files |
| `hooks.spec.ts` | hooks | it has to try the commands the hooks block and change |
| `integrations.spec.ts` | tacit and momentum | it has to answer from the memory the hook injected |
| `mcp-oauth.spec.ts` | mcp oauth sign-in | it has to find the server's tool with ToolSearch and run it |
| `nested-instructions.spec.ts` | nested instruction files load when the work reaches their folder | it has to read two files and follow the instructions loaded on the way |
| `phone.spec.ts` | phone control: read, tap by index, read again; not armed, stopped, turned off | it has to load the phone tools and tap what it read |
| `profile.spec.ts` | profile: the panel, and a model pick with reasoning and speed | it checks the tool profile, reasoning levels and speed of a Claude model |
| `readers.spec.ts` | readers: a folder of logs is read in parts and compiled into one answer | the readers and the model that asks them have to read the logs |
| `review.spec.ts` | independent review with findings | the reviewer has to read the change and write findings |
| `review.spec.ts` | reviewer mode judges calls | the reviewer has to judge calls against the owner's policy |
| `side-questions.spec.ts` | side questions stay out of the conversation | a side question is answered from what was said before |
| `skills.spec.ts` | skills: listed, run by the owner, loaded by the model | it has to follow a skill's instructions and load one by itself |
| `subagents.spec.ts` | subagents run in parallel, report back, and stop | it has to start two agents and gather their reports |
| `takeover.spec.ts` | take over a running session: ended where it ran, or copied with the one step | it has to load the import tool and take the session over |
| `trust.spec.ts` | trust, hooks and quarantine | it has to follow the project instructions once the folder is trusted |
| `wait-sources.spec.ts` | pull request checks and a socket feed wake the session | it has to set the waits with its tools from a plain prompt |
| `web-reader.spec.ts` | web reader: a long page is read for the prompt, the page saved whole | a reader model has to answer from a page WebFetch brings from the web (and the public network) |

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

## Pull request reviews from GitHub

Keel reviews the pull requests of the repositories you name, with no public
URL and no GitHub App. Watch one in Settings > Pull requests or with
`keel review watch OWNER/REPO`.

Keel polls two lists per repository: the open pull requests and the newest
comments. Each request carries the ETag of the last answer, so an unchanged
list is a 304, which GitHub does not count against the hourly limit. The pace
is the `X-Poll-Interval` GitHub sends, else 60 seconds, never faster:
`retry-after`, `x-ratelimit-remaining: 0` and secondary limits are obeyed.
That is two conditional requests a minute per repository; only a change
costs one. The Events API is not used: it has no event for a push to a pull
request and its latency can reach hours. `gh webhook forward` is for testing
only by GitHub's own words, and needs admin rights.

A review starts for a new head of a ready pull request (Every push, the
default), for a new pull request only, or only when asked. A comment whose
first line starts with `@keel review` (any case; the words are a setting)
asks for a review of the head, from an owner, a member or a collaborator.
What was open when the watch began is not reviewed unless asked.

Each head is reviewed once, ever, across restarts. The review is Keel's own
reviewer in a session of its own, read-only and sandboxed, in a checkout of
that head. Its findings are a draft you read in the session's Pull request
panel and post with one button. Turn on Post by itself for a repository and
each review is posted as a comment review: findings on changed lines inline,
the rest in its body. It never approves or requests changes. The Inbox
tells you each draft, post and failure.

Credentials: a token saved in Settings > Pull requests (kept in the system
keyring), else `GH_TOKEN` or `GITHUB_TOKEN`, else your gh login. The token
is never printed and never on a command line.

## Backups

`keel backup` writes a checked copy under `<state>/backups`: the database, the
settings files, the uploaded files, and the files of the config folder (MCP
servers, hooks, skills, plugins, agents, instructions). The daemon makes one
before a restart, and right after the start when it would have been a full
copy (see below). `keel backups` lists them.

A backup is made in a worker, so the daemon keeps answering meanwhile. The
database is kept compressed (`keel.db.zst`, which `zstd -d` reads too). When
few pages changed since the newest full backup, a backup holds only those
pages (`keel.db.delta.zst`) and names that full backup; `keel restore` reads
both. A delta is taken while the changed pages are at most one in `keep`
(the number of backups kept, 5 by default), so the deltas beside a full
backup never outweigh a second one. A full backup stays for as long as a
kept backup is read over it. Each backup records the SHA-256 of the
database it restores to (of the file, or of its pages' hashes in order), and
a restore checks it.

Which pages changed is read from the store's write-ahead log: each frame of
the log names its page, and the daemon keeps those page numbers beside the
store (`log-pages.db`) as the log is written and before it starts again. A
delta made this way reads only the changed pages, so its time is the
change's, not the store's. It is made only when the log was read without a
gap since the backup before it. When it was not (the log started again
unseen, the machine went down, the store was restored), the backup hashes
every page of the store and compares, as before. One backup in every `keep`
compares every page whatever the log says, and at least one a week: it
reports a page the log did not name, marks the deltas made from the log
since the last compare, and from then on every backup compares.

A restart waits for a delta: made from the log when the log tells, in
well under a second whatever the store's size, else by the compare. It
never waits for a full backup (the first one of a store, one whose changes
have outgrown a delta): that one is noted beside the backups before the
restart goes on, and the daemon that starts makes it within a minute, with
the reason "after a restart". A backup that can neither be made nor noted
calls the restart off, as before.

What a backup was checked for before it got its name:

- A full backup: SQLite's integrity check passed on the snapshot that was
  read, and the file was read back whole to the recorded SHA-256.
- A delta: every page that differs from its full backup is in it (found by
  comparing every page, or named by the log), read from one snapshot; the
  delta was read back and each page matches. One made from the log also
  reads a few hundred pages the log did not name: each must be as the full
  backup has it. It is not read back whole and SQLite's check is not run
  then: both take time in proportion to the store, and a restart waits on
  its backup.
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
the daemon across restarts and never stops it. Nothing is bundled: the page
is drawn by Qt WebEngine where the distribution has it installed, else by the
system web view. Build it with `desktop/build.sh`; see
[desktop/README.md](desktop/README.md).

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
