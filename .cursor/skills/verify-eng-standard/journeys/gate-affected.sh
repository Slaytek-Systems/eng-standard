# shellcheck shell=bash
# eng gate --event pr with verification.pr_checks: affected runs only the checks whose # covers: paths the branch changed,
# once each (flake_runs_pr: 1). A broken check the branch does not reach is skipped on the PR and fails main's gate. A
# change to eng.config.yml, or a --base that is not the PR's target, runs every check.
source "$(dirname "$0")/lib.sh"
init_repo gate-affected
yaml_set "c.verification.pr_checks='affected';c.verification.flake_runs_pr=1;c.hygiene.run_rules.ephemeral_runs.mode='off'"
expect 0 sh -c "mkdir -p src/a src/b .eng/checks && echo a > src/a/x.txt && echo b > src/b/y.txt \
  && printf '#!/bin/sh\n# covers: src/a\necho ran check a\n' > .eng/checks/a.sh \
  && printf '#!/bin/sh\n# covers: src/b\necho ran check b\nexit 1\n' > .eng/checks/b.sh && chmod +x .eng/checks/*.sh"
expect 0 eng sync
expect 0 git add -A
expect 0 git commit -qm 'two checks covering two paths; b is broken'
expect 0 git checkout -qb feat
expect 0 sh -c 'echo a2 >> src/a/x.txt && git commit -qam "change src/a only"'
expect 0 eng gate --event pr --base main checks
has 'checks: 1 of 2, those whose # covers: paths changed against main (verification.pr_checks: affected); each runs 1 time'
has 'pass         check:a   check a: passed 1/1'
has 'unaffected   check:b   not run on this pull request: it covers none of the 1 changed path'
has 'eng gate: PASS'
expect 1 eng gate checks
has 'checks: all 2 (no --event)'
has 'FAIL check b'
expect 1 eng gate --event pr --base main~1 checks
has "is not the pull request's target"
has 'FAIL check b'
expect 0 sh -c "printf '# touched on the branch\n' >> eng.config.yml && git commit -qam 'touch eng.config.yml'"
expect 1 eng gate --event pr --base main checks
has 'checks: all 2, because eng.config.yml changed'
has 'FAIL check b'
