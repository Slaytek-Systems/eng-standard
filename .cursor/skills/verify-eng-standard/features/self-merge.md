# Self-merge decision

`scripts/pr-gate.mjs merge` is how code lands on this repo's `main` (AGENTS.md "Merge rule"). For one PR it reads main's tip and `test` run, the PR, its files, statuses, `test` check, compare and verdict comments through `gh api`, then `decide()` says merge or skip. `--dry-run` prints `WOULD MERGE` and makes no write. It is not shipped to consumers. The journey runs the checkout's copy, which is the code `self-merge.yml` runs once this commit is main.

## Sub-features

- `merge-pass` merges a risk:low head with a `verifier_logins` PASS comment, the `verdict` status success, `test` green and main's tip contained.
- `merge-refuse-hold` skips a PR with the `hold` label.
- `merge-refuse-behind` skips a head that does not contain main's tip.
- `merge-refuse-other-head` skips when the only verdict is for another head, even with a `verdict` status success on the new head.
- `merge-refuse-fail` skips on a `verdict` status failure, and on a FAIL that is the verifier's latest verdict while the status still says success.
- `merge-refuse-login` skips a PASS comment posted by a login that `verifier_logins` does not list.
- `run-guard` holds a PASS back while that verifier's `eng-run/...` status is pending. The owner's end or a `verifier_logins` login's `error` releases it. Another account's success does not. A pending status stops holding at its start plus timeout plus 300 s.
- `statuses-strict` refuses to merge when a status row has no creator, or a context looks like `eng-run/` but does not parse.

## How to get to it (user POV)

- Self-merge runs on events in `.github/workflows/self-merge.yml`. By hand: `node scripts/pr-gate.mjs merge --pr <n> --dry-run` with `gh` logged in.

## Driving it with verify.sh

Preconditions:

- A repo that `eng init` set up, with `origin` at `https://github.com/fake/repo.git`, so `eng run --by` posts its statuses. Branch `feat` has one commit.
- `journeys/fake-gh.mjs` first on PATH as `gh`, `GH_STATE` at a JSON state file, `GITHUB_REPOSITORY=fake/repo` and `FAKE_GH_LOGIN` set to the posting account. The state holds PR 7 (head = `feat`, label `risk:low`), its one file, and `test` success on main and the head. The fake serves the reads, records the comments and statuses eng posts, and refuses every other call.

- **No verdict.** `node <src>/scripts/pr-gate.mjs merge --pr 7 --dry-run` prints `skip: no verdict status on head`.
- **Pass.** `eng run --by v1 -- true`, then `eng verdict PASS --by v1 --pr 7`. Both exit 0, and the state now holds the run's pending and success `eng-run/v1/...` statuses, the `eng-verdict/v1` comment and the `verdict` status. The gate prints `#7 <head8>: WOULD MERGE: risk:low: PASS by v1`.
- **Hold.** Add the `hold` label in the state. `skip: hold label`.
- **Behind.** Set the compare's `behind_by` to 1. `does not contain main's tip`.
- **Other head.** Commit again and point PR 7 at the new head, with `test` success and a `verdict` success status there. `stale verdicts (for <old8>), none for head <new8>`.
- **Login.** From the state before any verdict, as `FAKE_GH_LOGIN=collab`: `eng run --by v2 -- true` and `eng verdict PASS --by v2 --pr 7`. The gate prints `skip: no verdict comment for head`.
- **FAIL.** `eng run --by v1 -- false` and `eng verdict FAIL --by v1 --pr 7` exit 1. The gate prints `skip: verdict is failure on head`. Add a `verdict` success row: `skip: verdict FAIL by v1 on head <head8> (its latest)`.
- **Run in progress.** `eng run --by v1 -- node <src>/scripts/pr-gate.mjs merge --pr 7 --dry-run` prints `a run by v1 is still in progress`. Afterwards the gate prints `WOULD MERGE` again.
- **Dead run.** Add a pending row on a new `eng-run/v1/...` context, posted now. `still in progress`. collab posts success on it through `gh api`: still `still in progress`. The login posts `error` on it: `WOULD MERGE`. A pending row from 2106 s ago (timeout 1800 + 300 + 6) gives `WOULD MERGE`, and one from 2094 s ago gives `still in progress`.
- **Strict rows.** A row with `creator: null`, or a pending row with context `eng-run/v1/zzz`: `the statuses on head <head8> cannot be read`.
- **No writes.** The state's call log holds no `PUT`, `/merge`, `dispatches` or `labels` call.
- **Journey.** `verify.sh journey <id> self-merge`.

## Gotchas

- The scratch repo keeps its own run log and verdict notes, which a reset of the fake state does not undo. After `eng run --by v1 -- false`, a local `eng verdict PASS --by v1` is refused, so the login step runs before the FAIL step and uses `v2`.
- A row added to the state takes its id from the fake's counter (`++s.nextStatus`). Self-merge orders rows by id only, so a fixed id misorders them.
- The run's `eng-run` status reaches the fake only because `origin` names github.com. The real `gh` is never called.
- The dead-run steps assume the gate reads within 6 s of the state edit.
