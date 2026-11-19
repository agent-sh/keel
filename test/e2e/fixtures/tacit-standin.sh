#!/usr/bin/env bash
# A stand-in for tacit's hooks (TACIT_BIN): answers like tacit does, from a fixed
# memory. Each call is logged as "hook payload" to $TACIT_STANDIN_LOG when set.
input=$(cat)
[ -n "$TACIT_STANDIN_LOG" ] && printf '%s %s\n' "$2" "$input" >> "$TACIT_STANDIN_LOG"
case "$2" in
  session-start) echo "# tacit: this owner's standing rules"; echo "- keel-bun-e2e: sessions of the e2e workspace are tests" ;;
  prompt) echo "# tacit: facts matching this request"; echo "- code-word: the code word for this test is heron" ;;
  pre-tool) echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"- echo-rule: echo commands in tests are fine"}}' ;;
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
