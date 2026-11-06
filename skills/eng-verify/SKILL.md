---
name: eng-verify
description: "Record a fail-before/pass-after verdict for a behaviour check on the exact commit, and re-check verdicts after main merges in. Use after the pstack tdd or Bug fix step that proves the check, and after every merge-in of main."
---

# eng-verify

pstack owns the method: `tdd` and the Bug fix playbook (step 5) prove a check fails before the fix and passes after; `principle-prove-it-works` says what counts as proof; drive the app through the repo's `verify-<app>` skill (`create-verification-skill`). This skill only records the result so CI can enforce it.

## Before any verify skill: the repo owns its launch
pstack `create-verification-skill` assumes a Launch exists; `maintain-verification-skill` reports harness and product gaps instead of patching them in the skill. So:
1. Run `eng launch-check`. If it fails with "repo has no isolated launch", that is gap 1. Stop. Do not create or extend `verify-<app>`.
2. Fix it in the codebase: `launch:` in eng.config.yml with up/doctor/down that honour ENG_RUN_ID, ENG_PORT and ENG_RUN_DIR (basename(ENG_RUN_DIR) == ENG_RUN_ID for every run eng starts, so a launch script may check it; unix sockets go in ENG_SOCK_DIR under eng ephemeral, with a fallback when it is unset; free port per run, own db/storage per run, kill only own PIDs, evidence outside the repo). `eng launch-check` must pass, including the second concurrent run.
3. The verify skill's Launch, Doctor and Cleanup sections only call those three commands. Never put locks, PID hunting, container deadlines, private databases or storage emulators inside a verify skill.
4. Cap review rounds on a verify skill at 2. A review finding about isolation or infra is not fixed in the skill: record `eng mistake launch-infra "<finding>"` and fix launch in the codebase. `eng retro` routes `launch*` classes to level 1 (architecture).

## Record (per change)
1. Write `.eng/checks/<id>.sh` that drives the real behaviour (via `verify-<app>`) and exits 0 only when it is right. First line: `# covers: <paths>`.
2. Commit the fix and the check, then `eng verify create <id>`. Done: it FAILS on the merge-base, PASSES on HEAD, and writes a git note on HEAD.

## Re-check (after a rebase onto main or a merge-in)
1. `eng verify maintain`. Done: every check re-run on the new SHA, flaky and stale checks named, patch-id compared with the last proof (pstack Shipping step 3).
2. Flaky → fix the check or the race. Stale → re-prove or delete in a reviewed PR.
3. Merge also needs `eng verdict check`: a verdict from verification tooling, matched by patch-id, so a rebase that keeps the patch keeps it. Who runs it does not matter; the builder may. The verifier runs each check on the exact commit (`eng verdict round --by <id> -- <cmd>`: the app, e2e, property and mutation tests, formal checks), then `eng verdict PASS --by <id>` attaches those runs. `--review` counts only for docs and policy text (`verification.review_only_paths`).
4. A mistake seen twice → `eng mistake <key> "<what>"`, then the pstack `correct` skill picks the fix level; `custom-lint` is its lint rung.
