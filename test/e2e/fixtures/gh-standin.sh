#!/usr/bin/env bash
# Stands in for gh in `gh pr view N --repo OWNER/NAME --json state,statusCheckRollup`:
# prints $KEEL_GH_STANDIN_DIR/OWNER_NAME_N.json (the e2e writes it), else fails as gh does.
dir=${KEEL_GH_STANDIN_DIR:-$HOME/.cache/keel-work/bun/e2e-state/gh}
n=$3 repo=$5
f="$dir/${repo/\//_}_$n.json"
if [ "$1 $2" = "pr view" ] && [ -f "$f" ]; then cat "$f"; exit 0; fi
echo "GraphQL: Could not resolve to a PullRequest with the number of $n. (repository.pullRequest)" >&2
exit 1
