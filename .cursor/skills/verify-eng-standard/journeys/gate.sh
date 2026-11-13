# shellcheck shell=bash
# eng gate runs every script in .eng/checks before the gates in gates.required: a failing check fails the gate even with
# a counted PASS for the exact head, and the same gate passes once the check passes.
source "$(dirname "$0")/lib.sh"
init_repo gate
yaml_set "c.gates.required=['verdict'];c.hygiene.run_rules.ephemeral_runs.mode='off'"
expect 0 sh -c "mkdir -p .eng/checks && printf '#!/bin/sh\nexit 1\n' > .eng/checks/broken.sh && chmod +x .eng/checks/broken.sh"
expect 0 eng sync
expect 0 git add -A
expect 0 git commit -qm 'gate on verdict, with a broken check'
expect 0 git checkout -qb feat
expect 0 sh -c 'echo one > a.txt && git add a.txt && git commit -qm one'
pass() { for v in v1 v2; do expect 0 eng run --by $v -- true; expect 0 eng verdict PASS --by $v; done; expect 0 eng verdict check; }
pass
expect 1 eng gate
has 'FAIL check broken: failed'
expect 0 sh -c "printf '#!/bin/sh\nexit 0\n' > .eng/checks/broken.sh && git commit -qam 'fix the check'"
pass
expect 0 eng gate
