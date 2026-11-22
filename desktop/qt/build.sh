#!/usr/bin/env bash
# Builds the Qt WebEngine engine of the desktop app: desktop/dist/keel-desktop-qt.
#   desktop/qt/build.sh [OUT_DIR]
# Needs a C++ compiler and the development files of Qt WebEngine (Debian and
# Ubuntu: qt6-webengine-dev; Fedora: qt6-qtwebengine-devel). QT_CFLAGS, QT_LIBS
# and MOC take the place of what pkg-config says, for a Qt that is not
# installed in the usual place. Exit 3: those files are not there.
set -euo pipefail
cd "$(dirname "$0")"
mods="Qt6WebEngineWidgets Qt6WebChannel Qt6DBus"
if [ -z "${QT_CFLAGS:-}" ]; then
  if ! pkg-config --exists $mods; then
    echo "qt/build.sh: the development files of Qt WebEngine are missing (see the top of this file)" >&2
    exit 3
  fi
  # Its permission requests, which the program refuses one by one, came with Qt 6.8.
  if ! pkg-config --atleast-version=6.8 Qt6WebEngineWidgets; then
    echo "qt/build.sh: Qt WebEngine $(pkg-config --modversion Qt6WebEngineWidgets) is older than 6.8" >&2
    exit 3
  fi
fi
cflags=${QT_CFLAGS:-$(pkg-config --cflags $mods)}
libs=${QT_LIBS:-$(pkg-config --libs $mods)}
moc=${MOC:-$(pkg-config --variable=libexecdir Qt6Core)/moc}
out=${1:-../dist}
build=${KEEL_QT_BUILD_DIR:-build}
version=$(sed -n 's/^version = "\(.*\)"/\1/p' ../Cargo.toml | head -1)
mkdir -p "$build" "$out"
"$moc" main.cpp -o "$build/main.moc"
# shellcheck disable=SC2086
${CXX:-c++} -std=c++17 -O2 -fPIC -Wall -Wextra -DKEEL_VERSION="\"$version\"" $cflags -I"$build" main.cpp -o "$out/keel-desktop-qt" $libs
echo "built $out/keel-desktop-qt $version"
