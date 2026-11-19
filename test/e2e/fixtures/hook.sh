#!/usr/bin/env bash
# The hooks of the hooks e2e. They act only in its own folders (hooks-e2e-*), so
# other tests on the same daemon see nothing. Usage: hook.sh <event>
input=$(cat)
case "$KEEL_PROJECT_DIR" in *hooks-e2e-*) ;; *) exit 0 ;; esac
has() { printf '%s' "$input" | grep -q -- "$1"; }
case "$1" in
  prompt)
    if has 'refuse-me'; then echo '{"decision":"block","reason":"prompts that say refuse-me are not sent"}'; exit 0; fi
    echo "prompt-ctx: the password is falcon" ;;
  pre)
    if has 'forbidden'; then echo "no forbidden here" >&2; exit 2; fi
    if has 'askme'; then echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"askme commands need the owner"}}'; exit 0; fi
    if has 'allowme'; then echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}'; exit 0; fi
    echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"hook-ctx: the owner hook saw this call"}}' ;;
  post)
    echo '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"project-ctx: the repository hook saw the result"}}' ;;
  stop)
    if has '"stop_hook_active":true' || has 'AGAIN-DONE'; then exit 0; fi
    if has 'falcon'; then echo '{"decision":"block","reason":"Reply with the single word AGAIN-DONE."}'; fi ;;
esac
exit 0
