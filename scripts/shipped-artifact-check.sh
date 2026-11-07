#!/usr/bin/env bash
# Post-merge check on the shipped artifact (merge.auto.post_merge.check): the tests on the merged main, then the npm
# package as it ships (npm pack), installed into a clean project, must load and run. A failure opens an auto-revert.
set -euo pipefail
npm test
work=$(mktemp -d -p "${RUNNER_TEMP:-${ENG_TMP:?run under CI or an eng round}}" shipped-XXXXXX)
trap 'rm -rf "$work"' EXIT
npm pack --silent --pack-destination "$work" >/dev/null
cd "$work"
npm init -y >/dev/null
npm install --no-audit --no-fund --silent ./*.tgz
npx --no-install eng --help >/dev/null
mkdir repo && cd repo && git init -q -b main && cp ../node_modules/@slayteksystems/eng-standard/templates/eng.config.yml .
npx --no-install eng e2e --required --files docs/a.md --json | grep -q '"required": false'
echo "shipped artifact OK: $(ls "$work"/*.tgz | xargs -n1 basename)"
