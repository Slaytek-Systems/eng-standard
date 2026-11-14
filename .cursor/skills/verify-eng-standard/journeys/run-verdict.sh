# shellcheck shell=bash
# eng run --by records a run on the exact commit; eng verdict PASS counts it and eng verdict check passes for that head
# only. A new commit has no verdict, and a failed run refuses a PASS.
source "$(dirname "$0")/lib.sh"
init_repo run-verdict
expect 0 git checkout -qb feat
expect 0 sh -c 'echo one > a.txt && git add a.txt && git commit -qm one'
expect 0 eng run --by v1 -- true
has 'as verdict evidence'
expect 0 eng verdict PASS --by v1
has 'recorded PASS (verification, 1 run) by v1'
expect 0 eng verdict check
has 'eng verdict: PASS'
expect 0 sh -c 'echo two >> a.txt && git commit -qam two'
expect 1 eng verdict check
has 'no verdict for HEAD'
expect 1 eng run --by v1 -- false
has '(exit 1) as verdict evidence'
expect 1 eng verdict PASS --by v1
has 'exited 1'
expect 1 eng verdict check
expect 1 eng run --by a/b -- true
has 'cannot name a run status'
