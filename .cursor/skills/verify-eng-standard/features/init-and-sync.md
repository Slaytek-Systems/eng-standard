# Init and sync

`eng init` turns an empty git repo into one on the standard: it seeds `eng.config.yml`, renders AGENTS.md, SHIPPING.md, the git hooks, the guard and the skills, and points `core.hooksPath` at `.githooks`. `eng sync --check` then fails when a rendered file drifts, and `eng sync` puts it back.

## Sub-features

- `init-empty` seeds the config and renders every file on an empty repo.
- `sync-check-pass` passes when every rendered file matches the config.
- `sync-check-drift` fails and names the file after a hand edit.
- `sync-restore` rewrites the edited file.
- `pre-commit` runs `sync --check` and `eng lint` on `git commit`, and blocks a commit with a drifted file.

## How to get to it (user POV)

- Run `eng init` in a new repo.
- Run `eng sync` or `eng sync --check` after editing `eng.config.yml` or a rendered file.
- Run `git commit`, which runs `.githooks/pre-commit`.

## Driving it with verify.sh

Preconditions:

- A run from `verify.sh up`, and an empty repo from `verify.sh repo <id> <name>`.

- **Init.** Run `verify.sh sh <id> <name> -- eng init`. Exit 0, output has `seeded eng.config.yml` and `seeded .eng/rule-proofs/no-focused-tests`, and `eng.config.yml`, `AGENTS.md`, `SHIPPING.md`, `.eng/lock.json`, `.eng/guard/hook.mjs`, `.githooks/pre-commit`, `.agents/skills/eng-verify/SKILL.md` and `.eng/rule-proofs/no-focused-tests/src/cart.test.ts.fixture` exist. `git config core.hooksPath` prints `.githooks`.
- **Check passes.** Run `eng sync --check`. Exit 0 with `eng sync --check: PASS`.
- **Drift.** Append a line to `SHIPPING.md`, then run `eng sync --check`. Exit 1 with `SHIPPING.md: differs from what eng.config.yml renders`.
- **Restore.** Run `eng sync`. Output has `wrote SHIPPING.md`, and `eng sync --check` exits 0.
- **Hook passes.** `git add -A && git commit -m base`. Exit 0, output has `eng sync --check: PASS` and `eng lint: PASS`.
- **Hook blocks.** Append to `SHIPPING.md`, stage it, and commit. Exit 1 with `SHIPPING.md: differs`, and `git log` still shows only `base`.
- **Journey.** `verify.sh journey <id> init-sync`.

## Gotchas

- `eng init` already runs `eng sync`. Its output lists about 290 files.
- `eng sync` warns that Claude Code sees none of the skills. That is expected in a fresh repo: eng never makes the `.claude/skills` link.
