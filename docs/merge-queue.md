# eng-standard merge rule (v0.10.0)

Matt decided the rule on 24 Oct 2026 at 10:31 AM AEDT, then option 2 at 11:22 AM AEDT. `eng merge` is the gate this package ships for repos that adopt `merge.auto`. eng-standard itself keeps `self-merge.yml` ([self-merge.md](self-merge.md)) as its one merge path, because the strict path needs "Allow auto-merge" and a ruleset requiring `eng-merge-gate`, which only Matt changes.

Verdict comments, the trust policy (`author_association`, `verifier_logins`, an edited comment counts from its edit), and which verdicts count come from `lib/self-merge.mjs`, so both gates count verdicts the same way.

## Modes

| | `strict` (default) | `queue` (optional speed-up) |
|---|---|---|
| Where | any repo | org-owned public repos, or private on Enterprise Cloud (user-owned repos get HTTP 422) |
| Branch protection | required check `eng-merge-gate` (a status from `gate.yml`), strict (up to date with main), squash only, no bypass | required check `eng-merge-gate` (`gate.yml` on PR heads, `queued-gate` on the queued commit), merge queue of one, squash only, no bypass |
| Verdict binds | the exact PR head commit | the exact PR head that was queued (the sha in the merge_group `head_ref`), and the queued commit must carry the same patch-id. This is the one exception to exact-commit binding: GitHub builds the merge_group commit after the PR is queued, so no verifier can run it first; its own tests run in the same job |
| After main moves | `eng merge watch` updates the branch (auto-merge on), then the new head needs a new verdict | the queue rebuilds the merge_group commit; the verdict still binds the queued PR head, so a new PR head needs a new verdict |
| Who merges | GitHub auto-merge | the merge queue |

`eng doctor` reads the live repo (owner type, visibility, rulesets, auto-merge) and fails if the declared `merge.auto.mode` is not the one the repo runs. `eng merge settings` prints the ruleset for the declared mode and never applies it.

## Pieces

| Piece | Where | What it does |
|---|---|---|
| Config | `eng.config.yml` → `merge.auto` | Mode, the one required check, high-risk paths and verifier count, post-merge check, stuck and verdict-wait minutes, restart webhook secret, verifier logins |
| Required check | commit status `eng-merge-gate` | Posted by the trusted `.github/workflows/gate.yml` (reference copy: `templates/merge-auto/gate.yml`) (pull_request_target, workflow_run, issue_comment, dispatch: main's copy and main's code) after the PR's `test` check (`ci.yml`) finishes; in queue mode, `ci.yml` job `queued-gate` posts it on the queued commit. No job carries the name |
| Gate | `eng merge gate` → `lib/merge-cli.mjs` → `lib/merge-queue.mjs` | Passes when each verifier's latest verdict for the bound head or patch-id holds no FAIL and at least one PASS counts: verification with passing runs on its commit, or a review when every changed file matches `verification.review_only_paths` (`lib/verification.mjs`). Gate, auth and billing paths (`high_risk_paths`) need counted PASSes from `high_risk_verifiers` (default 2) distinct verifiers (`by` names). Who wrote the change plays no part: the builder may verify it (Matt, 6 Nov 2026). An `auto-revert` PR passes only when all hold: opened by `github-actions[bot]`, on `auto-revert/<sha12>`, its target is on main, and it is the exact inverse of the target from where it forked. If main has moved since, it is behind: `eng merge watch` updates it, dispatches `ci.yml` and `gate.yml` (a GITHUB_TOKEN push starts no workflows), and the new head must be the exact inverse on main's tip |
| Verdict | `eng verdict round --by <id> -- <cmd>`, then `eng verdict PASS\|PASS+NOTES\|FAIL --by <id> [--review] ... --pr <n>` | Carries the verifier's runs on the head (command, exit code, output, SHA). A git note, a PR comment (`<!-- eng-verdict/v1 -->` + JSON) that triggers `gate.yml`, the `verdict` commit status, and a dispatch of `gate.yml` as a fallback |
| Who may post | `merge.auto.verifier_logins` | When set, only comments written by a listed GitHub login count. This guards against forged comments; a verifier is still its `by` name. When unset, any write-access account can post, because every agent on the devbox posts as one GitHub account. `eng doctor` fails the check until it is set |
| Post-merge | `merge-post.yml` (`templates/merge-auto/`) → `eng merge post` | `scripts/shipped-artifact-check.sh` on main. On failure it opens `auto-revert/<sha12>`, labels it, turns on auto-merge and dispatches `ci.yml` with `pr`. It never reverts a revert; it escalates instead |
| Watch | `merge-watch.yml` (`templates/merge-auto/`) → `eng merge watch` | Every 10 min: `stuck` label; owner restart; update-branch for a behind auto-merge PR in strict mode; re-arms auto-merge once the gate passes (GitHub turns it off after a failed check); disarms it on the `hold` label |

## Adopting it in a repo (an admin applies the settings; `eng merge settings` prints them)

1. Copy the `merge` block of `templates/merge-auto/eng.config.yml` into the repo's `eng.config.yml`, and `gate.yml`, `merge-post.yml`, `merge-watch.yml` and the `queued-gate` job of `ci.yml` (queue mode only) from `templates/merge-auto/` into `.github/workflows/`. Remove any other merge controller in the same PR.
2. `gh api -X PATCH repos/<r> -F allow_auto_merge=true -F allow_squash_merge=true -F allow_merge_commit=false -F allow_rebase_merge=false -F delete_branch_on_merge=true`
3. Replace the main ruleset with the one `eng merge settings` prints: required check `eng-merge-gate` only (the gate reads the verdict and the tests itself), squash only, no bypass actors; strict in strict mode.
4. Allow GitHub Actions to create pull requests. Without it the auto-revert branch is pushed but its PR is refused, and `eng merge post` says so. `eng doctor` checks this.
5. Repo secret `ENG_RESTART_WEBHOOK`: the URL that restarts an owning job. Without it, `eng merge watch` only comments.
6. Post verdicts from a dedicated GitHub login (a bot account or GitHub App), and list it in `merge.auto.verifier_logins`.

Until lock A (required results from CI or one App the builder cannot forge) lands, the gate trusts recorded run evidence and does not re-run the commands, so a builder can certify its own risk:low PR. High-risk paths count distinct `--by` names, so one login posting under two names counts as two verifiers. See the caveats in [self-merge.md](self-merge.md).

eng-standard (`Slaytek-Systems/eng-standard`, org-owned and public, so both modes are available) has not adopted it: `allow_auto_merge` is false and its ruleset requires `test` and `verdict`.

## Break glass (Matt's call)

`gate.yml` runs from `main`, so a broken gate on `main` also gates the PR that fixes it. In the strict sandbox, a `gate.yml` that could not fetch a private repo's PR head left every PR without the required status, its own fix included. Keep `gate.yml` small and tested. A repo needs a written, owner-only recovery step for a broken gate (for example, the owner swaps the required check to the previous gate for one fix PR, and the swap is logged). Matt decides that step; eng never edits rulesets.

## Proof

- Unit and CLI tests: `test/merge-queue.test.mjs`.
- Strict mode end to end on `Mattslayga/eng-sandbox` (user-owned, private) and queue mode end to end on `Slaytek-Systems/eng-sandbox-queue` (org, public): `docs/evidence/2026-10-24-merge-rule-sandboxes.md`.
