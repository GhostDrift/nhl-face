#!/bin/sh
# Builds the face without the team logos, for publishing to the app store, and
# copies it to build/nhl-face-store.pbw. Without logos, the face always shows the
# game and standings, the wrist flick does nothing, and the goal banner is plain.
#
# Usage: tools/store_build.sh                  just build it
#        tools/store_build.sh [basalt|emery]   and install it on the running emulator
#        tools/store_build.sh --phone <ip>     and install it on the watch, through
#                                              the phone app's developer connection
#
# The app is built from a copy of the project, with NO_LOGOS defined and the logo
# images left out of the package, so the regular build keeps its logos.
set -e

root=$(cd "$(dirname "$0")/.." && pwd)
work=${TMPDIR:-/tmp}/nhl-face-store

rm -rf "$work"
mkdir -p "$work"
cp -r "$root/package.json" "$root/wscript" "$root/src" "$root/resources" "$work/"
ln -s "$root/node_modules" "$work/node_modules"

node -e '
var fs = require("fs");
var path = process.argv[1];
var pkg = JSON.parse(fs.readFileSync(path));
pkg.pebble.resources.media = pkg.pebble.resources.media.filter(function(r) {
  return r.name.indexOf("LOGO_") !== 0;
});
fs.writeFileSync(path, JSON.stringify(pkg, null, 2));
' "$work/package.json"
rm "$work"/resources/images/logo_* "$work/src/c/logos.h"

sed -i '1i #define NO_LOGOS 1' "$work/src/c/nhl-face.c"

cd "$work"
pebble build
cp "$work/build/nhl-face-store.pbw" "$root/build/"
echo "Built $root/build/nhl-face-store.pbw"
case "$1" in
  "") ;;
  --*) pebble install "$@" ;;
  *) pebble install --emulator "$1" ;;
esac
