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
exit 0
