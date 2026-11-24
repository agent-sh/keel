#!/usr/bin/env bash
# A stand-in for tacit's hooks (TACIT_BIN): answers like tacit does, from a fixed
# memory. Each call is logged as "hook payload" to $TACIT_STANDIN_LOG when set.
# A prompt holding the word standin:slow is answered after 5 s with nothing:
# longer than a turn waits for it, shorter than a hook process is left to run.
# It also answers the commands the Memory panel runs (search, fact, add), from
# a small store of its own. `mcp` is the store's MCP server (tacit-mcp-standin.ts).
[ "$1" = mcp ] && exec bun "$(dirname "$0")/tacit-mcp-standin.ts" "$@"
input=$(cat)
case "$1" in search|fact|add) ;; *) [ -n "$TACIT_STANDIN_LOG" ] && printf '%s %s\n' "$2" "$input" >> "$TACIT_STANDIN_LOG" ;; esac
case "$2:$input" in prompt:*standin:slow*) exec sleep 5 ;; esac
# A file named hook-delay in the store holds the seconds every hook takes (a store slow at a
# daemon's start, on a busy machine): each is answered after that, with what it would have said.
if [ -n "${TACIT_STANDIN_STORE:-}" ] && [ -f "$TACIT_STANDIN_STORE/hook-delay" ]; then case "$1" in search|fact|add) ;; *) sleep "$(cat "$TACIT_STANDIN_STORE/hook-delay")" ;; esac; fi
# The stand-in's store: three fixed facts and the notes `add` wrote under
# $TACIT_STANDIN_STORE, one line each (name, type, scope, kind, whether it is
# a note, created, description; tabs between).
store=${TACIT_STANDIN_STORE:-}
row() { printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$@"; }
held() {
  row keel-bun-e2e user_standard projects/keel-bun-e2e user false 2026-01-01 "sessions of the e2e workspace are tests"
  row code-word design_decision user observed false 2026-01-02 "the code word for this test is heron"
  row echo-rule user_standard user user false 2026-01-03 "echo commands in tests are fine"
  if [ -n "$store" ] && [ -d "$store" ]; then for f in "$store"/*.note; do [ -f "$f" ] && cat "$f"; done; fi
}
# Sixty more facts, given with a prompt that holds standin:many (a session with a long list) and opened by name.
many() { for i in $(seq -w 1 60); do row "many-$i" user_standard user observed false 2026-01-04 "filler fact $i for a long list"; done; }
esc() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
case "$1" in
  # `search [--json] [--limit N] [--inbox] [--] query`: the facts holding a
  # word, the most words first; a note only with --inbox. A search for
  # standin:slow gets no answer in the time the panel waits.
  search)
    shift; json=0; inbox=0; limit=10; words=()
    while [ $# -gt 0 ]; do
      case "$1" in --json) json=1 ;; --inbox) inbox=1 ;; --limit) limit=$2; shift ;; --) ;; *) for w in ${1,,}; do words+=("$w"); done ;; esac
      shift
    done
    case " ${words[*]} " in *" standin:slow "*) exec sleep 20 ;; esac
    rows=$(held | while IFS=$'\t' read -r name type scope kind note created desc; do
      [ "$note" = true ] && [ "$inbox" = 0 ] && continue
      text=" ${name,,} ${desc,,} "; n=0
      for w in "${words[@]}"; do case "$text" in *"$w"*) n=$((n + 1)) ;; esac; done
      [ "$n" -gt 0 ] && printf '%s\t' "$n" && row "$name" "$type" "$scope" "$kind" "$note" "$created" "$desc"
    done | sort -s -t$'\t' -k1,1nr | head -n "$limit")
    if [ "$json" = 1 ]; then
      [ -z "$rows" ] && { echo null; exit 0; }
      printf '['; sep=
      while IFS=$'\t' read -r n name type scope kind note created desc; do
        if [ "$note" = true ]; then path="inbox/claude@standin/$name.md"; else path="$scope/$name.md"; fi
        ruling=false; [ "$kind" = user ] && [ "$note" = false ] && ruling=true
        printf '%s{"Path":"%s","Name":"%s","Scope":"%s","Type":"%s","Description":"%s","Body":"%s","Inbox":%s,"Kind":"%s","Ruling":%s,"Created":"%s","Score":0.%s}' "$sep" "$path" "$name" "$scope" "$type" "$(esc "$desc")" "$(esc "$desc")" "$note" "$kind" "$ruling" "$created" "$n"
        sep=,
      done <<< "$rows"
      echo ']'
    elif [ -n "$rows" ]; then
      while IFS=$'\t' read -r n name type scope kind note created desc; do echo "- $name: $desc"; done <<< "$rows"
    fi
    exit 0 ;;
  # `fact NAME`: one fact as tacit prints it. A file named fact-delay in the
  # store holds the seconds a read takes (a store busy syncing).
  fact)
    if [ -n "$store" ] && [ -f "$store/fact-delay" ]; then sleep "$(cat "$store/fact-delay")"; fi
    found=$({ held; case "$2" in many-*) many ;; esac; } | awk -F'\t' -v n="$2" '$1 == n' | tail -n 1)
    [ -z "$found" ] && { echo "fact: not found: $2" >&2; exit 1; }
    IFS=$'\t' read -r name type scope kind note created desc <<< "$found"
    whose="agent note"; [ "$kind" = user ] && whose="your words"
    printf '# whose: %s is %s (%s)\n---\nname: %s\ndescription: %s\ntype: %s\nscope: %s\nsource:\n  harness: claude\n  host: standin\n  kind: %s\ncreated: "%s"\n---\n\n%s\n' "$name" "$whose" "$created" "$name" "$desc" "$type" "$scope" "$kind" "$created" "$desc"
    exit 0 ;;
  # `add --harness H [--kind K] [--type T] [--scope S] --desc D [--body B] NAME`: a note in the writer's inbox.
  add)
    # Its help names the writers it takes a note from, as tacit's does; a note from another is refused.
    if [ "$2" = --help ]; then printf 'Usage of add:\n  -harness string\n    \twriter harness, required: claude, codex (the owner writes in tacit app)\n' >&2; exit 0; fi
    shift; harness=; kind=observed; type=unclassified; scope=user; desc=; name=
    while [ $# -gt 0 ]; do
      case "$1" in --harness) harness=$2; shift ;; --kind) kind=$2; shift ;; --type) type=$2; shift ;; --scope) scope=$2; shift ;; --desc) desc=$2; shift ;; --body) shift ;; *) name=$1 ;; esac
      shift
    done
    [ -n "$TACIT_STANDIN_LOG" ] && printf 'add %s %s %s\n' "$harness" "$name" "$desc" >> "$TACIT_STANDIN_LOG"
    if [ -z "$harness" ] || [ -z "$desc" ] || [ -z "$name" ]; then echo "add: --harness, --desc and a name are required" >&2; exit 2; fi
    case "$harness" in claude|codex) ;; *) echo "add: unknown harness \"$harness\"" >&2; exit 2 ;; esac
    [ -z "$store" ] && { echo "add: the stand-in has no store (TACIT_STANDIN_STORE)" >&2; exit 2; }
    mkdir -p "$store"
    row "$name" "$type" "$scope" "$kind" true "$(date +%F)" "$desc" > "$store/$name.note"
    echo "added inbox/$harness@standin/$name.md"
    exit 0 ;;
esac
case "$2" in
  session-start) echo "# tacit: this owner's standing rules"; echo "- keel-bun-e2e: sessions of the e2e workspace are tests" ;;
  prompt)
    echo "# tacit: facts matching this request"; echo "- code-word: the code word for this test is heron"
    case "$input" in *standin:many*) many | while IFS=$'\t' read -r name type scope kind note created desc; do echo "- $name: $desc"; done ;; esac
    # A note comes with a prompt that holds one of its longer words (seven letters or more).
    if [ -n "$store" ] && [ -d "$store" ]; then
      low=${input,,}
      for f in "$store"/*.note; do
        [ -f "$f" ] || continue
        IFS=$'\t' read -r name type scope kind note created desc < "$f"
        for w in $desc; do
          w=${w//[^[:alnum:]]/}
          if [ "${#w}" -ge 7 ]; then case "$low" in *"${w,,}"*) echo "- $name: $desc"; break ;; esac; fi
        done
      done
    fi ;;
  # A command with standin:rule gets a rule that forbids a command (a RULE line, as the store marks one), any other the note.
  pre-tool) case "$input" in
    *standin:rule*) echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"- RULE standin-rule: never run `standin-banned` in this workspace"}}' ;;
    *) echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"- echo-rule: echo commands in tests are fine"}}' ;;
  esac ;;
  pre-compact) ;;
esac
# keel port: `tacit import [--store DIR] claude|codex DIR...` counts the memory files.
if [ "$1" = "import" ]; then
  shift; [ "$1" = "--store" ] && shift 2
  kind=$1; shift
  n=$(find "$@" -maxdepth 1 -name '*.md' 2>/dev/null | wc -l)
  [ -n "$TACIT_STANDIN_LOG" ] && printf 'import %s %s\n' "$kind" "$*" >> "$TACIT_STANDIN_LOG"
  echo "import $kind: written $n, unchanged 0, skipped 0, errors 0"
fi
exit 0
