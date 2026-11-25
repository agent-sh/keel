# Memory in Keel

Keel has three memory systems and a daily look at how each does.

## Native memory

A session reads and writes the memory of the harness its model was trained in, in the files and
places that harness uses, so one folder of notes serves Keel and that tool alike.

| | Claude family | GPT family |
| --- | --- | --- |
| Instructions | `~/.claude/CLAUDE.md`; then, from the home folder down to the working folder, `CLAUDE.md`, `.claude/CLAUDE.md`, `CLAUDE.local.md`. `AGENTS.md` is read only where none of those exists in the working folder or above. | `$CODEX_HOME/AGENTS.override.md`, else `AGENTS.md`; then, from the repository root down, the first non-empty of `AGENTS.override.md`, `AGENTS.md` and the config's fallback names in each folder, within `project_doc_max_bytes` (32 KiB). |
| Memory | Auto memory: `<claude config>/projects/<slug>/memory/`. `MEMORY.md` is the index (first 200 lines or 25 KB are in the prompt); topic files are read on demand. | Codex's memories, when `[features] memories = true`: `memories_v2/` (a fresh home) or `memories/` (where that folder exists, or `memories.version`). `memory_summary.md` (first 2,500 tokens) is in the prompt; the model searches `MEMORY.md` and the rollout summaries when the work calls for it. |
| Who writes | The model, with Write and Edit, one file per memory with `name`, `description` and `type` (user, feedback, project, reference) frontmatter, and a line in `MEMORY.md`. | Codex's own background extraction and consolidation of past sessions. Keel writes only an explicit remember, forget or correct request, as one note under `<memories>/extensions/ad_hoc/notes/`, with apply_patch or the shell; Codex applies it at its next consolidation. |
| Off | `CLAUDE_CODE_DISABLE_AUTO_MEMORY`, `autoMemoryEnabled: false` in the user settings; `autoMemoryDirectory` moves it. | `memories.use_memories = false`. |

The slug is the project's path with every character that is not a letter or a digit made a dash.
The project is the repository's main folder (a worktree shares its repository's folder), else the
working folder. Only the user's own settings may move the folder. An agent does not load its
parent's auto memory.

Other families keep the chain they had (`AGENTS.md`, else `CLAUDE.md`, of each folder).

The folders a model may write for memory are judged like the session's scratch folder: no card,
and nothing else outside the working folder. The index and the summary are read when the prompt is
made, as they are at a start and after a compaction elsewhere, and are not watched.

Before this, every session read the one chain above and the owner's Keel file, which held a copy
of each harness's user file made by the import. A session of a family that reads its own user file
now leaves the import's copies of the Claude and Codex files out of that file.

### Trust of a repository's instruction files

Every file either chain can load from a repository is under the trust pin, as `AGENTS.md` and `CLAUDE.md` are: `CLAUDE.local.md`, `.claude/CLAUDE.md`, `.claude/AGENTS.md`, `AGENTS.override.md` and the Codex config's fallback names. A new one is pinned on first sight (or waits for the owner when he asked to review new files); a changed one loads as the text last trusted until he trusts it in the session's Trust panel. The names are listed once, in `src/safety/instruction-files.ts`, which the chains, the trust scan and the read of a pull request head's base branch all use.

## The owner's store (tacit)

The store stays on top as before: its facts arrive at a session start, with a prompt and with a
tool call, in `<memory source="tacit">` blocks, and its tools write to it. The two divide by who
needs a fact:

- a rule, decision, preference or past mistake that holds across projects and tools: the store;
- what only this project's later sessions need (where things are, what is in flight): the native
  folder;
- never both, and never what a `<memory>` block or an instruction file already says.

The block of the prompt says so when the store is on for the session. It is an instruction to the
model; nothing blocks a duplicate. The daily sweep shows what each system gave and what a turn used.

## Momentum

Momentum reads Keel's session phases over the control socket and sends nudges (queue, steer,
interrupt). Each nudge it sends that Keel takes is kept as a row (action, session, time, no text).
The sweep reads what followed: the session's next turn ended on its own, was stopped, or failed.

## The daily sweep

Once a day (a few minutes after start when none ran in the last day, and on "Sweep now"), the
helper reads Keel's own records of the last 24 hours and writes a card, shown in Settings > Usage >
Memory > Daily sweep and in the helper's panel. Per system: what it gave, what a turn used of it,
and the share that helped.

| System | Helped is |
| --- | --- |
| Memory store | facts a turn named, of the facts given (the meter's proxy; it reads low) |
| Helper records | recalls a turn used, of the recalls made |
| Claude auto memory, Codex memories | sessions that read or wrote a file of it, of the sessions it was loaded into |
| Momentum | nudges after which the next turn ended on its own, of the nudges followed by a turn end |

It offers up to three improvements, never more than two of one kind. An offer changes something
only when pressed:

- drop a record the helper kept that no turn used for a month (forgets it);
- tidy an auto memory index: list the notes it misses, drop lines that point nowhere;
- drop a stale project note (moved to `.dropped/` in its folder, kept);
- send the store's curator a note about a fact given often and never named, or a rule no call
  tests. The command is shown first and runs on a second press. The store keeps editing and
  retiring facts to the owner.

No model is asked, and no file is changed until an offer is pressed. A card keeps the state of its
offers. The helper hears of each sweep with its next turn, and is not woken for it.
