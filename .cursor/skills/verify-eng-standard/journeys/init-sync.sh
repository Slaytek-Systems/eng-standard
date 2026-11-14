# shellcheck shell=bash
# eng init on an empty repo writes the config and the rendered files; sync --check passes, catches a hand edit, and
# eng sync restores it; the pre-commit hook it installs runs sync --check and lint.
source "$(dirname "$0")/lib.sh"
repo init-sync
expect 0 eng init
has 'seeded eng.config.yml'
has 'seeded .eng/rule-proofs/no-focused-tests'
for f in eng.config.yml AGENTS.md SHIPPING.md .eng/lock.json .eng/guard/hook.mjs .githooks/pre-commit .agents/skills/eng-verify/SKILL.md .eng/rule-proofs/no-focused-tests/src/cart.test.ts.fixture; do
  expect 0 test -s "$f"
done
expect 0 git config core.hooksPath
has '.githooks'
expect 0 eng sync --check
has 'eng sync --check: PASS'
expect 0 sh -c 'echo hand-edit >> SHIPPING.md'
expect 1 eng sync --check
has 'SHIPPING.md: differs from what eng.config.yml renders'
expect 0 eng sync
has 'wrote SHIPPING.md'
expect 0 eng sync --check
expect 0 git add -A
expect 0 git commit -m base
has 'eng sync --check: PASS'
has 'eng lint: PASS'
expect 0 sh -c 'echo hand-edit >> SHIPPING.md && git add SHIPPING.md'
expect 1 git commit -m 'hand edit'
has 'SHIPPING.md: differs'
expect 0 git log --format=%s
[ "$OUT" = base ] || { echo "JOURNEY FAIL: the blocked commit landed"; exit 1; }
echo "ok: only the base commit landed"
