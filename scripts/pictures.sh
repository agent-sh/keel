#!/usr/bin/env bash
# Pictures of the page for a change's review (src/pictures/run.ts, .keel/pictures.json).
#
#   scripts/pictures.sh SPEC...
#
# Runs the specs through scripts/smoke.sh (a daemon of its own on the scripted provider, no credentials,
# no network) with every shoot() taken at each size and theme Keel names (KEEL_SHOT_SIZES,
# KEEL_SHOT_THEMES), and copies the pictures to $KEEL_PICTURES_OUT. Keel runs it once on the base and
# once on the branch's head, with the head's specs on both. The dependencies are the checkout's own
# (linked or installed by Keel before it runs): nothing is installed here.
# Where the kernel gives a user no namespaces, the run goes without them (as scripts/remote-verify.sh does).
set -euo pipefail
TOP=$(cd "$(dirname "$0")/.." && pwd)
: "${KEEL_PICTURES_OUT:?KEEL_PICTURES_OUT names the folder the pictures go to}"
[ "$#" -gt 0 ] || { echo "pictures: name the specs to run" >&2; exit 2; }
net=()
unshare --user --map-root-user --net --pid --fork true 2> /dev/null || { net=(--allow-network); echo "pictures: no namespaces for a user here: running with --allow-network"; }
rc=0
bash "$TOP/scripts/smoke.sh" --installed --shots "$KEEL_PICTURES_OUT" "${net[@]}" "$@" || rc=$?
echo "pictures: $(find "$KEEL_PICTURES_OUT" -maxdepth 1 -name '*.png' | wc -l) taken (exit $rc)"
exit "$rc"
