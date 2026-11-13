# shellcheck shell=bash
# Sourced by each journey. $VERIFY and $RUN come from verify.sh journey.
repo() { REPO=$1-$$; "$VERIFY" repo "$RUN" "$REPO" >/dev/null; }
S() { "$VERIFY" sh "$RUN" "$REPO" -- "$@"; }
step() { printf '\n$ %s\n' "$*"; }
# expect <exit-code> <cmd...>: run it in the journey repo, keep its output in the log, fail the journey on another code.
expect() {
  local want=$1; shift; step "$@"; [ -z "${IN:-}" ] || echo "  stdin: $IN"; local rc=0
  OUT=$(S "$@" 2>&1 <<<"${IN:-}") || rc=$?
  printf '%s\n[exit %s]\n' "$OUT" "$rc"
  [ "$rc" = "$want" ] || { echo "JOURNEY FAIL: wanted exit $want from: $*"; exit 1; }
}
has() { grep -qF -- "$1" <<<"$OUT" || { echo "JOURNEY FAIL: output lacks: $1"; exit 1; }; echo "ok: output has: $1"; }
yaml_set() { S node -e "const Y=require(process.env.YAML),fs=require('fs'),c=Y.parse(fs.readFileSync('eng.config.yml','utf8'));$1;fs.writeFileSync('eng.config.yml',Y.stringify(c))"; }
export YAML=$PROJ/node_modules/yaml
init_repo() { repo "$1"; expect 0 eng init; expect 0 git add -A; expect 0 git commit -qm base; }
