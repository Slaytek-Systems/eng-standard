#!/usr/bin/env bash
# covers: bin/eng.mjs lib/verification.mjs
# The checks are the wall: in a repo whose only gate is verdict, a failing check fails eng gate even with a passing
# verdict for the exact head, and the same gate passes once the check passes.
set -euo pipefail
repo=$PWD eng="node $PWD/bin/eng.mjs"
d=$(mktemp -d -p "${ENG_TMP:?run under eng gate}")
trap 'rm -rf "$d"' EXIT
cd "$d"
export XDG_CACHE_HOME="$d/xdg" GIT_CONFIG_GLOBAL=/dev/null
git init -q -b main && git config user.email check@eng && git config user.name check
cp "$repo/templates/eng.config.yml" .
node -e "const Y=require('$repo/node_modules/yaml'),fs=require('fs'),c=Y.parse(fs.readFileSync('eng.config.yml','utf8'));c.gates.required=['verdict'];c.hygiene.run_rules.ephemeral_runs.mode='off';c.verification.flake_runs=1;fs.writeFileSync('eng.config.yml',Y.stringify(c))"
mkdir -p .eng/checks && printf '#!/bin/sh\nexit 1\n' > .eng/checks/broken.sh
echo x > a.txt && git add -A && git commit -qm base
git checkout -qb feat && echo y > a.txt && git commit -qam change
pass() { for v in check check-2; do $eng run --by $v -- true >/dev/null && $eng verdict PASS --by $v >/dev/null; done; }  # .eng/checks/** is risk:high: two distinct verifiers
pass && $eng verdict check >/dev/null
status=0; out=$($eng gate 2>&1) || status=$?  # nested gate: the fixture repo's gate is the subject under test
[ "$status" -ne 0 ] || { echo "eng gate passed with a failing check: $out"; exit 1; }
grep -q 'FAIL check broken: failed 1/1' <<<"$out" || { echo "eng gate did not run the check: $out"; exit 1; }
printf '#!/bin/sh\nexit 0\n' > .eng/checks/broken.sh && git commit -qam fix
pass
$eng gate >/dev/null || { echo 'eng gate failed with every check passing'; exit 1; }  # nested gate: the fixture repo's gate is the subject under test
echo 'a failing check fails eng gate despite a passing verdict; a passing one does not'
