# Gate on a pull request: affected checks only

With `verification.pr_checks: affected`, `eng gate --event pr` runs only the checks whose `# covers:` paths the branch changed against the PR's target, `verification.flake_runs_pr` times each. Main's gate (`--event main` or no `--event`) still runs every check. A change to `eng.config.yml`, `.eng/lock.json` or the checks dir, or a `--base` that is not the PR's target commit, runs every check.

## Sub-features

- `affected-select` a branch that changes one covered path runs that check and marks the other `unaffected`.
- `affected-runs-once` a selected check runs `flake_runs_pr` times (`passed 1/1`).
- `affected-main-all` the gate with no `--event` runs every check, so a broken unaffected check fails main's gate.
- `affected-base-not-target` a `--base` at another commit runs every check and says why.
- `affected-config-all` a change to `eng.config.yml` runs every check.

## How to get to it (user POV)

- A repo sets `verification.pr_checks: affected` (and usually `flake_runs_pr`) in `eng.config.yml`, runs `eng sync`, and CI runs `eng gate --event pr` on each pull request. Locally the user runs `eng gate --event pr --base main`.

## Driving it with verify.sh

Preconditions:

- A repo that `eng init` set up. Set `verification.pr_checks: affected`, `verification.flake_runs_pr: 1` and `hygiene.run_rules.ephemeral_runs.mode: off` (`yaml_set`). Add `src/a/x.txt`, `src/b/y.txt`, `.eng/checks/a.sh` with `# covers: src/a` that exits 0 and `.eng/checks/b.sh` with `# covers: src/b` that exits 1. Run `eng sync` and commit on `main`. Branch `feat` and commit a change to `src/a/x.txt` only.

- **Select.** `eng gate --event pr --base main checks`. Exit 0 with `checks: 1 of 2, those whose # covers: paths changed against main (verification.pr_checks: affected); each runs 1 time`, `pass check:a check a: passed 1/1`, `unaffected check:b not run on this pull request` and `eng gate: PASS`.
- **Main runs all.** `eng gate checks`. Exit 1 with `checks: all 2 (no --event)` and `FAIL check b`.
- **Other base.** `eng gate --event pr --base main~1 checks`. Exit 1, output has `is not the pull request's target` and `FAIL check b`.
- **Config change.** Append a comment to `eng.config.yml`, commit, then `eng gate --event pr --base main checks`. Exit 1 with `checks: all 2, because eng.config.yml changed` and `FAIL check b`.
- **Journey.** `verify.sh journey <id> gate-affected`.

## Gotchas

- Name the `checks` step so the gate skips `gates.required`, which needs project commands an empty repo lacks. Naming `checks` does not force every check to run. Naming `check:b` does.
- `--base HEAD~1` on a one-commit branch is main's tip, which is the PR's target, so selection still applies. Use a commit before main's tip to see the fallback.
- A scratch repo has no `origin`, so the target is local `main`. In CI the target is `origin/<base branch>`.
