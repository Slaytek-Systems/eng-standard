# Run and verdict

A verifier runs a command on the exact commit with `eng run --by <id> -- <cmd>`, which records the run as evidence, then records `eng verdict PASS --by <id>`. `eng verdict check` passes only when a counted PASS exists for HEAD.

## Sub-features

- `run-record` records the run, its exit code and its commit.
- `verdict-pass` records a PASS backed by a passing run on HEAD.
- `verdict-check-head` passes for that head and fails after a new commit.
- `run-deps` gives the command the checkout's `node_modules` as hard links when every lockfile matches the commit, and names the cause and `npm ci` when one differs.
- `verdict-refuse` refuses a PASS when the latest run of a command failed.

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
- **Deps.** With a committed `package-lock.json` and an installed `node_modules`, `eng run -- node -e 'import("<dep>")'` exits 0 and prints `node_modules: hard links to`. Edit the lockfile without committing: the same run prints `package-lock.json differs` and fails to import. The checkout's `node_modules` is unchanged after `eng run -- rm -rf node_modules`.
- **Journey.** `verify.sh journey <id> run-verdict`.

## Gotchas

- Verdicts live in the scratch repo's `refs/notes/eng-verdict` and `.git/eng`. Nothing is posted without `--pr`.
- On `main` with no change against the base, `eng verdict check` passes with `no change against base`. Use a feature branch.
