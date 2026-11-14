#!/usr/bin/env bash
# Drive the eng CLI the way a consuming repo does: the package as npm packs it, installed into a scratch project, run with
# npx --no-install eng inside a fresh git repo. Usage is in SKILL.md beside this file.
set -euo pipefail

SKILL=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SRC=${VERIFY_SRC:-$(git -C "$SKILL" rev-parse --show-toplevel)}
BASE=${VERIFY_ROOT:-${XDG_CACHE_HOME:-$HOME/.cache}/eng/verify-eng-standard}
RUNS=$BASE/runs EVIDENCE=$BASE/evidence

die() { echo "verify: $*" >&2; exit 2; }
run_dir() { [ -n "${1:-}" ] || die "name a run id (verify.sh up prints it)"; [ -f "$RUNS/$1/owner" ] || die "no run $1 under $RUNS"; echo "$RUNS/$1"; }

# The environment a drive sees: its own git identity, caches and latest-version source, and none of the CI or gate
# variables that change what eng does.
drive_env() {
  local r=$1
  env -u ENG_TMP -u ENG_TMP_BASE -u ENG_SCRATCH -u ENG_PR -u ENG_PR_LABELS -u ENG_BASE -u BUILDKITE -u GITHUB_ACTIONS \
    -u GITHUB_REF -u GITHUB_EVENT_NAME -u CI -u ENG \
    XDG_CACHE_HOME="$r/xdg" GIT_CONFIG_GLOBAL="$r/gitconfig" GIT_CONFIG_NOSYSTEM=1 ENG_STANDARD_SOURCE="$(cat "$r/src")" \
    PATH="$r/proj/node_modules/.bin:$PATH" "${@:2}"
}

cmd_up() {
  command -v node >/dev/null && command -v npm >/dev/null && command -v git >/dev/null || die "need node, npm and git on PATH"
  local id r; id=$(date +%Y%m%d-%H%M%S)-$$; r=$RUNS/$id
  mkdir -p "$r/xdg" "$r/proj" "$EVIDENCE/$id"
  echo "$$ $(id -un) $(date -Is)" > "$r/owner"; echo "$SRC" > "$r/src"
  git -C "$SRC" rev-parse HEAD > "$r/sha"
  printf '[user]\n\tname = verify\n\temail = verify@eng.invalid\n[init]\n\tdefaultBranch = main\n' > "$r/gitconfig"
  (cd "$SRC" && npm pack --silent --pack-destination "$r" >/dev/null)
  (cd "$r/proj" && npm init -y >/dev/null && npm install --no-audit --no-fund --silent "$r"/*.tgz)
  echo "$id"
}

cmd_doctor() {
  local r; r=$(run_dir "${1:-}"); local ok=0
  local want got; want=$(node -p "require('$(cat "$r/src")/package.json').version")
  got=$(node -p "require('$r/proj/node_modules/@slayteksystems/eng-standard/package.json').version" 2>/dev/null || echo none)
  [ "$want" = "$got" ] && echo "ok   installed eng-standard $got (packed from $(cat "$r/src") at $(cut -c1-12 "$r/sha"))" || { echo "FAIL installed $got, source is $want: run verify.sh up again"; ok=1; }
  [ "$(git -C "$(cat "$r/src")" rev-parse HEAD)" = "$(cat "$r/sha")" ] && echo "ok   source HEAD unchanged since up" || { echo "FAIL source HEAD moved since up: the package is stale, run verify.sh up again"; ok=1; }
  drive_env "$r" sh -c 'command -v eng' | grep -q "^$r/proj/node_modules/.bin/eng$" && echo "ok   eng resolves to the scratch install" || { echo "FAIL eng does not resolve to $r/proj/node_modules/.bin/eng"; ok=1; }
  echo "ok   node $(node -v), git $(git --version | cut -d' ' -f3)"
  echo "     run $r, evidence $EVIDENCE/$(basename "$r")"
  return $ok
}

# A fresh git repo for one journey, inside the scratch project so npx finds the install.
cmd_repo() {
  local r; r=$(run_dir "${1:-}"); local name=${2:?repo name}
  local d=$r/proj/$name; [ -e "$d" ] && die "$d exists: pick another name"
  mkdir -p "$d" && drive_env "$r" git -C "$d" init -q && echo "$d"
}

# Run a command in a journey repo with the drive environment, like a user typing it there.
cmd_sh() {
  local r; r=$(run_dir "${1:-}"); local d=$r/proj/${2:?repo name}; shift 2; [ "${1:-}" = -- ] && shift
  [ -d "$d" ] || die "no repo $d: run verify.sh repo first"
  (cd "$d" && drive_env "$r" "$@")
}

cmd_journey() {
  local id=${1:-}; run_dir "$id" >/dev/null; shift
  local names=("$@"); [ ${#names[@]} -gt 0 ] && [ "${names[0]}" != all ] || names=(init-sync doctor guard run-verdict gate gate-affected)
  local fail=0
  for j in "${names[@]}"; do
    local f=$SKILL/journeys/$j.sh log=$EVIDENCE/$id/$j.log
    [ -f "$f" ] || die "no journey $j (see $SKILL/journeys)"
    if VERIFY="$SKILL/verify.sh" RUN="$id" PROJ="$RUNS/$id/proj" bash -euo pipefail "$f" > "$log" 2>&1; then echo "PASS $j  ($log)"; else echo "FAIL $j  ($log)"; tail -5 "$log" | sed 's/^/     /'; fail=1; fi
  done
  return $fail
}

cmd_down() {
  local r; r=$(run_dir "${1:-}")
  rm -rf "$r"
  echo "removed $r; evidence kept at $EVIDENCE/$(basename "$r")"
}

case "${1:-}" in
  up) cmd_up ;;
  doctor|repo|sh|journey|down) c=$1; shift; "cmd_$c" "$@" ;;
  *) sed -n 's/^# \{0,1\}//; 2,3p' "$0"; echo "commands: up | doctor <run> | repo <run> <name> | sh <run> <name> -- <cmd...> | journey <run> [all|<name>...] | down <run>"; exit 2 ;;
esac
