# Gate

`eng gate` runs every script in `verification.checks_dir` first, then every gate in `gates.required`. A failing check fails the gate even when the verdict passes. Skipped or missing counts as failed.

## Sub-features

- `gate-check-fails` a failing `.eng/checks` script fails the gate despite a counted PASS.
- `gate-pass` the same gate passes once the check passes and the new head has its PASSes.
- `gate-high-risk` a commit under `.eng/checks/` needs PASSes from two distinct `--by` names.

## How to get to it (user POV)

- Run `eng gate` locally, or let CI run it.

## Driving it with verify.sh

Preconditions:

- A repo that `eng init` set up. Set `gates.required: [verdict]` and `hygiene.run_rules.ephemeral_runs.mode: off` (`yaml_set` in `journeys/lib.sh`), add `.eng/checks/broken.sh` that exits 1, run `eng sync`, and commit on `main`. Then branch and commit one change.

- **PASSes.** For `v1` and `v2`: `eng run --by <v> -- true`, `eng verdict PASS --by <v>`. `eng verdict check` exits 0.
- **Check fails.** `eng gate`. Exit 1 with `FAIL check broken: failed` while the verdict line says `pass`.
- **Check fixed.** Make `broken.sh` exit 0, commit, record both PASSes again, then `eng gate`. Exit 0 with `eng gate: PASS` and `2 of 2 verifiers`.
- **Journey.** `verify.sh journey <id> gate`.

## Gotchas

- The template's `flake_runs: 3` runs each check three times per gate.
- With the template's full `gates.required`, the gate also needs typecheck, test, launch and e2e commands that an empty repo lacks. Narrow it to `[verdict]` for this journey.
- `.eng/checks/gate-runs-checks.sh` in this repo drives the same behavior from the source tree. This journey drives the packed install.
