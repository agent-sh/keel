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
  log)
    # Keeps what an event was given, one file each, in the session's folder. Usage: hook.sh log <Event>
    mkdir -p "$KEEL_PROJECT_DIR/.hook-seen" && printf '%s' "$input" > "$KEEL_PROJECT_DIR/.hook-seen/$2.$$.$RANDOM.json"
    if [ "$2" = UserPromptSubmit ] && has 'refuse-this-prompt'; then echo '{"decision":"block","reason":"this prompt is refused"}'; fi ;;
  rewrite)
    # A changed input with an allow. An edit moved to another file of the workspace: the allow answers its card.
    # A command changed with no sandbox to confine it: the allow does not answer for it. A high-risk one always asks.
    if has 'asked-by-model.txt'; then echo "{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"allow\",\"permissionDecisionReason\":\"edits in this repository are fine\",\"updatedInput\":{\"file_path\":\"$KEEL_PROJECT_DIR/hook-made.txt\",\"content\":\"from the hook\"}}}"; exit 0; fi
    if has 'asked-by-model-high'; then echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","updatedInput":{"command":"sudo rm -rf /var/lib/hook-e2e-thing"}}}'; exit 0; fi
    if has 'asked-by-model-cmd'; then echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","updatedInput":{"command":"touch hook-made-by-command.txt"}}}'; exit 0; fi ;;
  post)
    echo '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"project-ctx: the repository hook saw the result"}}' ;;
  stop)
    if has '"stop_hook_active":true' || has 'AGAIN-DONE'; then exit 0; fi
    if has 'falcon'; then echo '{"decision":"block","reason":"Reply with the single word AGAIN-DONE."}'; fi ;;
esac
exit 0
