#!/usr/bin/env bash
# Builds the desktop shell.
#   desktop/build.sh            the release binary: desktop/dist/keel-desktop
#   desktop/build.sh deb        that, and a Debian package beside it (--with-keel adds ../dist/keel as /usr/bin/keel)
#   desktop/build.sh install    that, installed for this account: the binary, the launcher, the icons and the keel:// handler
#   desktop/build.sh test       the unit tests
# Needs cargo and the development files of GTK 4 and WebKitGTK 6 (Debian and
# Ubuntu: libgtk-4-dev libwebkitgtk-6.0-dev; Fedora: gtk4-devel webkitgtk6.0-devel).
# With the development files of Qt WebEngine too (qt6-webengine-dev;
# qt6-qtwebengine-devel) it also builds desktop/dist/keel-desktop-qt, the
# program that draws the windows with Chromium where the distribution's Qt
# WebEngine is installed (see qt/build.sh). Without them the app is built
# alone and draws its windows with the system web view.
set -euo pipefail
cd "$(dirname "$0")"
ID=io.github.agent_sh.Keel
what="${1:-build}"
if [ "$what" = test ]; then
  cargo test --locked
  # The other engine's program decides the same paths by the same table.
  if [ -x dist/keel-desktop-qt ]; then dist/keel-desktop-qt --self-test test/paths.txt; fi
  exit 0
fi
for lib in gtk4 webkitgtk-6.0; do
  pkg-config --exists "$lib" || { echo "build.sh: the development files of $lib are missing (see the top of this file)" >&2; exit 1; }
done
cargo build --release --locked
target="${CARGO_TARGET_DIR:-target}"
mkdir -p dist
install -m 755 "$target/release/keel-desktop" dist/keel-desktop
version=$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -1)
echo "built dist/keel-desktop $version"
qt=0
qt/build.sh "$PWD/dist" || qt=$?
case "$qt" in
  0) ;;
  3) rm -f dist/keel-desktop-qt; echo "built without the Qt WebEngine engine: the app draws its windows with the system web view" ;;
  *) exit "$qt" ;;
esac

# The files of an install under a prefix: the binary, the launcher, the icons.
lay() {
  local root="$1" bin="$2" share="$3"
  install -D -m 755 dist/keel-desktop "$root$bin/keel-desktop"
  # (The app looks for the other engine's program beside itself.)
  if [ -x dist/keel-desktop-qt ]; then install -D -m 755 dist/keel-desktop-qt "$root$bin/keel-desktop-qt"; else rm -f "$root$bin/keel-desktop-qt"; fi
  install -D -m 644 "assets/$ID.desktop" "$root$share/applications/$ID.desktop"
  install -D -m 644 "assets/$ID.svg" "$root$share/icons/hicolor/scalable/apps/$ID.svg"
  install -D -m 644 "assets/$ID-symbolic.svg" "$root$share/icons/hicolor/symbolic/apps/$ID-symbolic.svg"
}

case "$what" in
  build) ;;
  deb)
    arch=$(dpkg --print-architecture)
    pkg="dist/keel-desktop_${version}_${arch}"
    rm -rf "$pkg"
    lay "$pkg" /usr/bin /usr/share
    if [ "${2:-}" = --with-keel ]; then
      [ -x ../dist/keel ] || { echo "build.sh: ../dist/keel is missing: run bun scripts/build.ts first" >&2; exit 1; }
      install -D -m 755 ../dist/keel "$pkg/usr/bin/keel"
    fi
    install -D -m 644 ../LICENSE "$pkg/usr/share/doc/keel-desktop/copyright"
    # The Qt WebEngine engine is used where its libraries are installed; the package does not force them.
    recommends="Suggests: libqt6webenginewidgets6"
    if [ -x dist/keel-desktop-qt ]; then recommends="Recommends: libqt6webenginewidgets6 (>= 6.8), libqt6webchannel6, libqt6dbus6"; fi
    mkdir -p "$pkg/DEBIAN"
    cat > "$pkg/DEBIAN/control" <<CONTROL
Package: keel-desktop
Version: $version
Section: devel
Priority: optional
Architecture: $arch
Depends: libgtk-4-1 (>= 4.12), libwebkitgtk-6.0-4 (>= 2.42)
$recommends
Maintainer: Keel <noreply@github.com>
Homepage: https://github.com/agent-sh/keel
Description: Keel in a window of its own
 A small native shell around the Keel daemon's page: a window with no
 browser around it, a tray mark with the count of what waits, native
 notifications whose click opens the session, and keel:// links.
CONTROL
    dpkg-deb --root-owner-group --build "$pkg" > /dev/null
    rm -rf "$pkg"
    echo "built $pkg.deb"
    ;;
  install)
    share="${XDG_DATA_HOME:-$HOME/.local/share}"
    lay "" "${KEEL_DESKTOP_PREFIX:-$HOME/.local}/bin" "$share"
    # The launcher starts the binary where it was put, whatever the PATH of the desktop session.
    sed -i "s|^Exec=keel-desktop|Exec=${KEEL_DESKTOP_PREFIX:-$HOME/.local}/bin/keel-desktop|" "$share/applications/$ID.desktop"
    command -v update-desktop-database > /dev/null && update-desktop-database "$share/applications" || true
    command -v gtk4-update-icon-cache > /dev/null && gtk4-update-icon-cache -q -t "$share/icons/hicolor" 2> /dev/null || true
    command -v xdg-mime > /dev/null && xdg-mime default "$ID.desktop" x-scheme-handler/keel || true
    echo "installed keel-desktop for this account; keel:// links open it"
    ;;
  *) echo "usage: desktop/build.sh [build|deb [--with-keel]|install|test]" >&2; exit 2 ;;
esac
