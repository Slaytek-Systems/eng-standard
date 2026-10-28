# eng-standard: agent rules for this repo

This repo is the package that renders AGENTS.md and SHIPPING.md for other repos. It does not render its own (do not
run `eng sync` here). Its own settings live in the root `eng.config.yml`.

## Merge rule (approved by Matt, 19 Oct 2026, 3:55 PM AEDT; independence by identity 26 Oct 2026; CI is the verifier 28 Oct 2026)

- **Self-merge.** `.github/workflows/self-merge.yml` runs main's code only and squash-merges at most one PR into
  `main` per run. It runs on events only, never on a schedule: `ci` or `verify` finished, a review verdict comment, a
  label added or removed, ready for review, retargeted to main, or a manual dispatch. Runs queue one at a time. There
  is no wait: a PR merges as soon as every condition below holds on its current head SHA, and each one is read again
  just before the merge call:
  - The head contains main's tip (ancestry check). A behind branch is updated and its new head verified again.
  - **CI is the verifier** (Matt, 28 Oct 2026). `.github/workflows/verify.yml` runs `npm ci && npm test` on the PR's
    exact head commit on `pull_request_target`, so its workflow code is main's and the PR cannot edit it. The gate
    counts only a successful run whose path is that file, whose event is `pull_request_target` and whose head SHA is
    the PR's current head. A pass on an older push, a PR's own workflow (even one named `verify`), a verdict comment
    or a `verdict` status never stands in for it.
  - **risk:low:** the verify run on the exact head. Nothing else.
  - **risk:high:** the verify run **and** agent review: PASS verdict comments for that exact head from
    `ship.high_risk.verifiers` (default 2) independent reviewers with distinct identities. Review is separate from
    verification; it is still self-declared (`--by` from the shared account), so it adds a second opinion but is not
    what proves the change works. Signed review verdicts were offered to Matt and are undecided.
  - **Independence is identity.** A reviewer counts only when its identity (`--by`, and its GitHub login when
    `ship.self_merge.verifier_logins` is set) matches no author's: no `Agent:` trailer id, commit email or login.
  - A PR is risk:high when any changed path matches `ship.high_risk.paths` in `eng.config.yml`: workflows
    and CI, this merge setup, `bin/`, `scripts/`, package scripts and dependencies, vendored code, and auth or
    billing paths. `.github/workflows/risk-label.yml` sets the label on every push, and self-merge recomputes it.
  - For risk:high, no review, a review for another head, or a FAIL refuses the merge. Each reviewer's latest verdict counts, and
    any FAIL blocks.
  - No `hold` label and not draft.
- **Post-merge check.** After each merge self-merge runs `ci.yml` on `main`. When it finishes, `ci.yml` starts
  self-merge again. If it failed, that run opens the merged
  commit's exact inverse as an `auto-revert/<sha12>` PR from `github-actions[bot]`. While main is red it is the only PR
  that may merge, and it still needs every condition above. A PR opened by `GITHUB_TOKEN` fires no
  `pull_request_target`, so the revert PR has no verify run until Matt closes and reopens it (known gap).
- **Nobody bypasses anything**, Matt included: no `--admin`, no `--no-verify`, no merging around a red or missing check.
  Authors never merge their own PR and never post its review verdict.
- **Review verdict (risk:high only):** each reviewer runs `eng verdict PASS|FAIL --by <id> --pr <n>` on the exact head,
  with its own identity. That posts an `eng-verdict/v1` PR comment (head SHA, identity), which self-merge reads, and a
  `verdict` status, which no longer gates anything. Authors put an `Agent:`
  trailer on every commit so the gate can tell who wrote the patch.
- **Stop one PR:** add the `hold` label. **Stop all:** `gh workflow disable self-merge.yml`.
- **Undo:** `gh pr revert <n>` (one step: opens the revert PR, which goes through the same gates).

Details, the checker command and the GitHub settings: [docs/self-merge.md](docs/self-merge.md).

`eng merge` (v0.10.0, `merge.auto`) is the strict auto-merge gate this package ships for other repos. It is not live
here: `templates/merge-auto/` holds its workflows, and switching eng-standard to it needs Matt's settings change and a
PR that removes `self-merge.yml` in the same change. Until then `self-merge.yml` is the only merge path.
