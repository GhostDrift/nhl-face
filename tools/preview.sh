#!/bin/sh
# Builds "NHL Face Preview", a watch app for flipping through every team's color
# schemes with the goal banner up, and installs it on the emulator or a watch.
# Down and up step through the schemes; select flips between home and away.
#
# Usage: tools/preview.sh [basalt|emery]   on the running emulator (default basalt)
#        tools/preview.sh --phone <ip>     on the watch, through the phone app's
#                                          developer connection
#        tools/preview.sh --build-only     just build the .pbw, to sideload
#
# The app is built from a copy of the project, with PREVIEW defined, the preview's
# phone code added, and its own UUID, so the real face is left alone.
set -e

root=$(cd "$(dirname "$0")/.." && pwd)
work=${TMPDIR:-/tmp}/nhl-face-preview

rm -rf "$work"
mkdir -p "$work"
cp -r "$root/package.json" "$root/wscript" "$root/src" "$root/resources" "$work/"
ln -s "$root/node_modules" "$work/node_modules"

node -e '
var fs = require("fs");
var path = process.argv[1];
var pkg = JSON.parse(fs.readFileSync(path));
pkg.name = "nhl-face-preview";
pkg.pebble.displayName = "NHL Face Preview";
pkg.pebble.uuid = "5b0c7a2e-4f1d-4d8a-9c3e-2a7f6b1e9d04";
pkg.pebble.watchapp.watchface = false;
pkg.pebble.messageKeys.push("PreviewStep", "PreviewLabel");
fs.writeFileSync(path, JSON.stringify(pkg, null, 2));
' "$work/package.json"

sed -i '1i #define PREVIEW 1' "$work/src/c/nhl-face.c"
cp "$root/tools/preview/preview.js" "$work/src/pkjs/"
echo "require('./preview');" >> "$work/src/pkjs/index.js"

cd "$work"
pebble build
echo "Built $work/build/nhl-face-preview.pbw"
case "$1" in
  --build-only) ;;
  --*) pebble install "$@" ;;
  *) pebble install --emulator "${1:-basalt}" ;;
esac
