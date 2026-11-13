---
name: verify-eng-standard
description: Drive the eng CLI from this repo (eng-standard) the way a consuming repo does, to prove CLI behavior on a commit. Packs this checkout with npm pack, installs it into a scratch project, and runs eng init, sync, doctor, run, verdict, gate and the rendered guard hook in fresh git repos. Use to verify an eng-standard change, reproduce a CLI bug, or take the next item from coverage.md.
---

# Verify eng-standard

The user surface is the `eng` CLI acting on someone else's git repo. Never drive it against this checkout: `eng sync` must not run here (AGENTS.md), and this repo's own config is not a consumer's. Every drive runs in a scratch git repo under a run directory that `verify.sh` owns.

All commands run from the repo root. `V=.cursor/skills/verify-eng-standard/verify.sh`.

## Launch

There is no server. Launch packs the checkout once per commit and installs it the way the docs tell a consumer to (`docs/lifecycle.md`, "Pin"), so the drive sees exactly the files `package.json` `files` ships.

```sh
ID=$($V up)          # prints the run id, e.g. 20261113-021645-4065899
```

Ready means `up` printed an id and exited 0. It takes about 2 seconds. The run lives in `${VERIFY_ROOT:-$XDG_CACHE_HOME/eng/verify-eng-standard}/runs/$ID`. `VERIFY_SRC=<checkout>` packs a different eng-standard checkout, such as a PR head in another worktree.

Each run is its own directory with its own git identity, `XDG_CACHE_HOME` and package, so runs can go side by side. Two agents never share a run id.

## Doctor

```sh
$V doctor $ID
```

It checks that the installed version matches the source `package.json`, that the source HEAD has not moved since `up` (a moved HEAD means the package is stale, so run `up` again), and that `eng` resolves to the scratch install. Run it first, and again whenever a result looks wrong.

## Drive

Run the mapped journeys:

```sh
$V journey $ID all                    # or name them: init-sync doctor guard run-verdict gate
```

It prints `PASS <journey>` or `FAIL <journey>` with the log path, and exits 1 if any journey failed. Each journey is a script in `journeys/` that makes its own fresh repo, so journeys can run again in the same run.

Drive by hand for a journey that does not exist yet:

```sh
$V repo $ID try1                      # fresh git repo at runs/$ID/proj/try1
$V sh $ID try1 -- eng init            # any command, in that repo, with the run's environment
$V sh $ID try1 -- git commit -qm base
```

`$V sh` puts the scratch install's `node_modules/.bin` first on PATH, which is what `npx --no-install eng` resolves to, and drops the CI and gate variables (`ENG_TMP`, `GITHUB_ACTIONS`, `ENG_PR` and others) that change what eng does. The git hooks that `eng init` installs run on `git commit` and use the same install. The feature map in `features/README.md` lists each feature, its entry points and the end state that proves it.

To add a journey, write `journeys/<name>.sh`, source `lib.sh`, and use its helpers: `init_repo <name>` (fresh repo, `eng init`, first commit), `expect <exit-code> <cmd...>`, `has <text>` (on the last command's output), `IN=<json> expect ...` (stdin), and `yaml_set '<js on c>'` (edit `eng.config.yml` as a user would). Add it to the default list in `verify.sh` and to the feature map.

## Evidence

Each journey writes `evidence/$ID/<journey>.log`: every command, its full output and its exit code, plus each `ok:` assertion. The evidence directory sits beside `runs/`, not inside it, so cleanup keeps it.

Proof standards:

- Drive the packed CLI and the files it renders (the git hooks, `.eng/guard/hook.mjs` through the exact command in `.claude/settings.json`). Never import `lib/` or call internal functions.
- Assert the action and the end state: the exit code, the line eng prints, and the file or git state it changed (a commit that did or did not land, a file restored).
- A journey that fails on main is a bug finding. Report it with the log. Never weaken the journey to make it pass.
- `eng doctor` reads the latest version from `ENG_STANDARD_SOURCE`, which `verify.sh` points at the source checkout. Nothing in the journeys calls GitHub. `eng verdict` without `--pr` writes only to the scratch repo.

## Cleanup

```sh
$V down $ID           # removes runs/$ID only; prints where the evidence stays
```

`down` removes only the run directory that `up` made. It kills nothing. Each `eng run` and `eng gate` removes its own round and TMPDIR on exit. A killed run can leave a TMPDIR under `~/.cache/eng/t/`, which eng reaps on its next gate.

## Helpers

- `verify.sh up | doctor <id> | repo <id> <name> | sh <id> <name> -- <cmd...> | journey <id> [all|<name>...] | down <id>`.
- `journeys/lib.sh` holds the journey helpers named above.

## Gotchas

- `eng init` renders about 290 files and prints a line for each, so journey logs are long. Search them for `JOURNEY FAIL` and `$ ` (each command).
- The template sets `verification.flake_runs: 3`, so a check runs three times per gate (`failed 3/3`).
- Files under `.eng/checks/` are risk:high in the template, so a gate on such a commit needs PASSes from two distinct `--by` names.
- On `main` with nothing changed against the base, `eng verdict check` passes with `no change against base`. Put the change on a feature branch to test a real verdict.
- The skill lives in `.cursor/skills/`, which Cursor reads. Codex and Claude Code do not discover it, so read this file by path.

## Not covered yet

`coverage.md` beside this file ranks what the journeys do not reach, most bug-prone first. A daily run takes the top item, writes its journey, and removes the item. Use `/maintain-verification-skill` (`vendor/pstack/skills/maintain-verification-skill/SKILL.md`) to keep the map current as the CLI changes.
