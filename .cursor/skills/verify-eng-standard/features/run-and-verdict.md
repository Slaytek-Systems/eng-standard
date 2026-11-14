# Run and verdict

A verifier runs a command on the exact commit with `eng run --by <id> -- <cmd>`, which records the run as evidence, then records `eng verdict PASS --by <id>`. `eng verdict check` passes only when a counted PASS exists for HEAD.

## Sub-features

- `run-record` records the run, its exit code and its commit.
- `verdict-pass` records a PASS backed by a passing run on HEAD.
- `verdict-check-head` passes for that head and fails after a new commit.
- `verdict-refuse` refuses a PASS when the latest run of a command failed.
- `run-by-id` refuses a `--by` with a `/` or a space, which no `eng-run/...` status can carry.

## How to get to it (user POV)

- A verifier on a feature branch runs `eng run --by v1 -- <cmd>`, then `eng verdict PASS --by v1`, then `eng verdict check`.

## Driving it with verify.sh

Preconditions:

- A repo that `eng init` set up and committed, on a feature branch with one change committed.

- **Run.** `eng run --by v1 -- true`. Exit 0, output has `as verdict evidence`.
- **PASS.** `eng verdict PASS --by v1`. Exit 0, output has `recorded PASS (verification, 1 run) by v1`.
- **Check.** `eng verdict check`. Exit 0, output has `eng verdict: PASS`.
- **New head.** Commit another change, then `eng verdict check`. Exit 1 with `no verdict for HEAD`.
- **Failed run.** `eng run --by v1 -- false` exits 1 with `(exit 1) as verdict evidence`. `eng verdict PASS --by v1` then exits 1 and names the run that `exited 1`. `eng verdict check` still exits 1.
- **Bad id.** `eng run --by a/b -- true`. Exit 1, output has `cannot name a run status`.
- **Journey.** `verify.sh journey <id> run-verdict`.

## Gotchas

- Verdicts live in the scratch repo's `refs/notes/eng-verdict` and `.git/eng`. `eng verdict` posts nothing without `--pr`. Since 0.23.0 `eng run --by` posts a pending, then success or failure, `eng-run/<id>/<8 hex>-<run id>` commit status, but only when `origin` is on github.com. A scratch repo has no `origin`, so the journey posts nothing.
- On `main` with no change against the base, `eng verdict check` passes with `no change against base`. Use a feature branch.
