# eng-standard verification map

This directory is the maintained source for verifying what a consuming repo sees from the `eng` CLI. Read this index, then use the matching feature file as the recipe. Each feature has a journey script in `../journeys/` that runs the recipe.

## Baseline preconditions

- A run made by `verify.sh up` from the checkout under test, and `verify.sh doctor <id>` passes.
- Each journey starts from an empty git repo inside the run (`verify.sh repo`), never from this checkout.
- `ENG_STANDARD_SOURCE` points at the source checkout, so nothing reads GitHub.

## Driving conventions

- Run every command through `verify.sh sh <id> <repo> -- <cmd>`, which resolves `eng` to the packed install.
- Treat each command as literal. Assert the exit code and the line eng prints, not only that something printed.
- Commit through `git commit` so the hooks `eng init` installs run.

## Proof and skip reporting

- CLI proof is the command, its output and its exit code, in `evidence/<id>/<journey>.log`.
- A mutation also needs the resulting state: the file restored, the commit that did or did not land, the verdict that does or does not count.
- Report a journey that fails on the commit under test as a finding, with the log. Do not change the journey to pass.
- Do not report an entry point as verified through a different one. The rendered hook proves the guard; a call into `lib/guard.mjs` does not.

## Features

- [Init and sync](./init-and-sync.md) covers `eng init` on an empty repo, `eng sync`, `eng sync --check` and the pre-commit hook.
- [Doctor](./doctor.md) covers `eng doctor` on a repo `eng init` set up.
- [Guard](./guard.md) covers the rendered guard hook as Claude Code and Cursor run it.
- [Run and verdict](./run-and-verdict.md) covers `eng run --by`, `eng verdict PASS` and `eng verdict check` on the exact head.
- [Gate](./gate.md) covers `eng gate` with a check script and a required verdict.

Not reached yet: `../coverage.md`.
