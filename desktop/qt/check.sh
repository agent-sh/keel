#!/usr/bin/env bash
# Compiles the Qt WebEngine engine (desktop/qt/main.cpp) in a container that has the development
# files of Qt WebEngine, then runs its --self-test on the Qt "offscreen" platform (no display).
#   desktop/qt/check.sh [DESKTOP_DIR]
# DESKTOP_DIR is the desktop/ folder to check (this one by default), so another checkout can be
# built with the script of this one. Needs Docker or Podman (KEEL_QT_CONTAINER names the command).
# The image is built from desktop/qt/Dockerfile once and kept under a tag of its content.
# The source is mounted read-only and copied inside; the container has no network.
# Exit: 0 built and the self-test passed, 1 failed, 3 no container engine.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
src=$(cd "${1:-$here/..}" && pwd)
[ -f "$src/qt/main.cpp" ] || { echo "qt/check.sh: $src has no qt/main.cpp" >&2; exit 2; }
engine=${KEEL_QT_CONTAINER:-}
if [ -z "$engine" ]; then
  for e in docker podman; do command -v "$e" > /dev/null && { engine=$e; break; }; done
fi
[ -n "$engine" ] || { echo "qt/check.sh: neither docker nor podman is installed" >&2; exit 3; }
tag=keel-qt-check:$(sha256sum "$here/Dockerfile" | cut -c1-12)
if ! "$engine" image inspect "$tag" > /dev/null 2>&1; then
  echo "qt/check.sh: building the image $tag (once per Dockerfile)"
  "$engine" build -q -t "$tag" -f "$here/Dockerfile" "$here" > /dev/null
fi
echo "qt/check.sh: building $src/qt in $tag"
"$engine" run --rm --network none --cpus 4 --memory 6g -v "$src:/src:ro" -e QT_QPA_PLATFORM=offscreen "$tag" bash -euc '
  cp -r /src /tmp/desktop
  cd /tmp/desktop
  KEEL_QT_BUILD_DIR=/tmp/qtbuild qt/build.sh /tmp/qtout
  /tmp/qtout/keel-desktop-qt --version
  /tmp/qtout/keel-desktop-qt --self-test test/paths.txt
'
