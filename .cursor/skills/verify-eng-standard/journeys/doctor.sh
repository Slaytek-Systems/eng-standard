# shellcheck shell=bash
# eng doctor on a repo eng init just set up: the version lines name the installed, rendered and latest release, and the
# repo passes with no problems.
source "$(dirname "$0")/lib.sh"
init_repo doctor
want=$(node -p "require('$PROJ/node_modules/@slayteksystems/eng-standard/package.json').version")
step eng doctor; rc=0; OUT=$(S eng doctor 2>&1) || rc=$?; printf '%s\n[exit %s]\n' "$OUT" "$rc"
has "installed $want, rendered $want (.eng/lock.json), latest $want"
has 'ok   claude-code: wired'
[ "$rc" = 0 ] || { echo "JOURNEY FAIL: eng doctor exits $rc on a repo eng init just set up"; exit 1; }
