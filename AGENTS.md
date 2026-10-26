# eng-standard: agent rules for this repo

This repo is the package that renders AGENTS.md and SHIPPING.md for other repos. It does not render its own (do not
run `eng sync` here). Its own settings live in the root `eng.config.yml`.

## Merge rule (approved by Matt, 19 Oct 2026, 3:55 PM AEDT; independence by identity 26 Oct 2026)

- **Self-merge.** `.github/workflows/self-merge.yml` runs main's code only and squash-merges at most one PR into
  `main` per run. Every condition below must hold on the PR's current head SHA:
  - The head contains main's tip (ancestry check). A behind branch is updated and its new head verified again.
  - The `test` check is green and the `verdict` status is success.
  - **Independence is identity.** A verifier counts only when its identity (`--by`, and its GitHub login when
    `ship.self_merge.verifier_logins` is set) matches no author's: no `Agent:` trailer id, commit email or login.
  - **risk:low:** one PASS for that exact head from an independent verifier.
  - **risk:high:** PASSes for that exact head from `ship.high_risk.verifiers` (default 2) independent verifiers with
    distinct identities. A PR is risk:high when any changed path matches `ship.high_risk.paths` in `eng.config.yml`: workflows
    and CI, this merge setup, `bin/`, `scripts/`, package scripts and dependencies, vendored code, and auth or
    billing paths. `.github/workflows/risk-label.yml` sets the label on every push, and self-merge recomputes it.
  - No verdict, a verdict for another head, or a FAIL refuses the merge. Each verifier's latest verdict counts, and
    any FAIL blocks.
  - No `hold` label and not draft. Everything has been green for the hold window (`ship.self_merge.hold_minutes`,
    default 120).
- **Post-merge check.** After each merge self-merge runs `ci.yml` on `main`. If it fails, the next run opens the merged
  commit's exact inverse as an `auto-revert/<sha12>` PR from `github-actions[bot]`. While main is red it is the only PR
  that may merge, and it still needs every condition above.
- **Nobody bypasses anything**, Matt included: no `--admin`, no `--no-verify`, no merging around a red or missing check.
  Authors never merge their own PR and never post its verdict.
- **Verdict:** each verifier runs `eng verdict PASS|FAIL --by <id> --pr <n>` on the exact head, with its own identity.
  That posts an `eng-verdict/v1` PR comment (head SHA, identity) and the `verdict` status. Authors put an `Agent:`
  trailer on every commit so the gate can tell who wrote the patch.
- **Stop one PR:** add the `hold` label. **Stop all:** `gh workflow disable self-merge.yml`.
- **Undo:** `gh pr revert <n>` (one step: opens the revert PR, which goes through the same gates).

Details, the checker command and the GitHub settings: [docs/self-merge.md](docs/self-merge.md).

`eng merge` (v0.10.0, `merge.auto`) is the strict auto-merge gate this package ships for other repos. It is not live
here: `templates/merge-auto/` holds its workflows, and switching eng-standard to it needs Matt's settings change and a
PR that removes `self-merge.yml` in the same change. Until then `self-merge.yml` is the only merge path.
