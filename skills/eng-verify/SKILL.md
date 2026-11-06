---
name: eng-verify
description: "Prove a behaviour check fails before the fix and passes after it, and run it on the exact commit as verdict evidence. Use after the pstack tdd or Bug fix step that proves the check, and after every rebase or merge-in of main."
---

# eng-verify

pstack owns the method: `tdd` and the Bug fix playbook (step 5) prove a check fails before the fix and passes after; `principle-prove-it-works` says what counts as proof; drive the app through the repo's `verify-<app>` skill (`create-verification-skill`). This skill runs the check on the exact commit and records the verdict, so CI can enforce it.

## Before any verify skill: the repo owns its launch
pstack `create-verification-skill` assumes a Launch exists; `maintain-verification-skill` reports harness and product gaps instead of patching them in the skill. So:
1. Run `eng doctor --launch`. If it fails with "repo has no isolated launch", that is gap 1. Stop. Do not create or extend `verify-<app>`.
2. Fix it in the codebase: `launch:` in eng.config.yml with up/doctor/down that honour ENG_RUN_ID, ENG_PORT and ENG_RUN_DIR (basename(ENG_RUN_DIR) == ENG_RUN_ID for every run eng starts, so a launch script may check it; unix sockets go in ENG_SOCK_DIR under `eng run launch`, with a fallback when it is unset; free port per run, own db/storage per run, kill only own PIDs, evidence outside the repo). `eng doctor --launch` must pass, including the second concurrent run.
3. The verify skill's Launch, Doctor and Cleanup sections only call those three commands. Never put locks, PID hunting, container deadlines, private databases or storage emulators inside a verify skill.
4. Cap review rounds on a verify skill at 2. A review finding about isolation or infra is not fixed in the skill: fix launch in the codebase.

## Record (per change)
1. Write `.eng/checks/<id>.sh` that drives the real behaviour (via `verify-<app>`) and exits 0 only when it is right. First line: `# covers: <paths>`.
2. Prove it bites: run this checkout's check against the base, `eng run --ref <merge-base> -- bash "$PWD/.eng/checks/<id>.sh"`. It must FAIL on the behaviour, not because a file is missing. On HEAD it PASSES.
3. Commit the fix and the check, then run it as evidence on the exact commit: `eng run --by <id> -- bash .eng/checks/<id>.sh`, then `eng verdict PASS --by <id>`.

## Re-check (after a rebase onto main or a merge-in)
1. A rebase, an amend or a merge-in of main makes a new commit. Re-run every check on it with `eng run --by <id> -- <cmd>`. A verdict never carries from another commit.
2. Flaky → fix the check or the race. A check whose `covers` paths are gone → re-prove or delete it in a reviewed PR.
3. Merge needs `eng verdict check`: a verdict from verification tooling for the exact HEAD commit. Who runs it does not matter; the builder may. The verifier runs each check on the exact commit (`eng run --by <id> -- <cmd>`: the app, e2e, property and mutation tests, formal checks), then `eng verdict PASS --by <id>` attaches those runs. `--review` counts only for docs and policy text (`verification.review_only_paths`).
4. A mistake seen twice → the pstack `correct` skill picks the fix level; `custom-lint` is its lint rung.
