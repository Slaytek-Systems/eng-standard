# eng-standard: agent rules for this repo

This repo is the package that renders AGENTS.md and SHIPPING.md for other repos. It does not render its own (do not
run `eng sync` here). Its own settings live in the root `eng.config.yml`.

## Merge rule (approved by Matt, 19 Oct 2026, 3:55 PM AEDT; verification tooling decides, 6 Nov 2026)

- **Self-merge.** `.github/workflows/self-merge.yml` runs main's code only and squash-merges at most one PR into
  `main` per run. It runs on events only, never on a schedule: `ci` finished, a verdict comment or `verdict` status, a
  label added or removed, ready for review, retargeted to main, an `eng run --by` that ended, the settle wait below, or
  a manual dispatch. Runs queue one at a time. A PR merges once every condition below holds on its current head SHA,
  and each one is read again just before the merge call:
  - The head contains main's tip (ancestry check). A behind branch is updated and its new head verified again.
  - The `test` check is green and the `verdict` status is success.
  - **Verification tooling decides, not who ran it** (Matt, 6 Nov 2026). A PASS counts when it carries passing runs on
    that exact head. The builder may verify its own work. With `ship.self_merge.verifier_logins` set, only those GitHub
    logins may post verdicts, which guards against forged comments.
  - **risk:low:** one counted PASS for that exact head.
  - **risk:high:** counted PASSes for that exact head from `ship.high_risk.verifiers` (default 2) distinct verifiers
    (`--by` names, such as two tools or lanes). A PR is risk:high when any changed path matches `ship.high_risk.paths` in `eng.config.yml`: workflows
    and CI, this merge setup, `bin/`, `scripts/`, package scripts and dependencies, vendored code, and auth or
    billing paths. `.github/workflows/risk-label.yml` sets the label on every push, and self-merge recomputes it.
  - **Until lock A lands (caveats, 6 Nov 2026).** The builder may certify its own risk:low PR for self-merge, because
    no gate compares the verifier with the authors (by design). The gate trusts the recorded run evidence (command,
    exit code, output, SHA): it checks those fields and that every run is on the exact head, but it does not re-run
    the commands at merge time. Required results from CI or one App the builder cannot forge (lock A) close this later.
  - **Distinct verifiers are `--by` names.** risk:high counts distinct `--by` names, so one GitHub login that posts
    under two `--by` names counts as two verifiers. That is the rule: verifiers are tools or lanes, not people.
  - No verdict, a verdict for another head, or a FAIL refuses the merge. Each verifier's latest verdict counts, and
    any FAIL blocks.
  - **Settle guard** (Eng Manager decision, 13 Nov 2026). A verifier's PASS does not count while that verifier still
    has an `eng run --by` in progress on the head (commit status `eng-run/<id>/...` pending). Nothing merges until
    `ship.self_merge.settle_minutes` (default 10) have passed since the newest verdict on the head;
    `self-merge-settle.yml` runs self-merge again when the window ends. Why 10: [docs/self-merge.md](docs/self-merge.md).
  - No `hold` label and not draft.
- **Post-merge check.** After each merge self-merge runs `ci.yml` on `main`. When it finishes, `ci.yml` starts
  self-merge again. If it failed, that run opens the merged
  commit's exact inverse as an `auto-revert/<sha12>` PR from `github-actions[bot]`. While main is red it is the only PR
  that may merge, and it still needs every condition above.
- **Nobody bypasses anything**, Matt included: no `--admin`, no `--no-verify`, no merging around a red or missing check.
  Nobody merges by hand: self-merge merges.
- **Verdict.** A verifier (a tool, lane or agent, the builder included) runs the change on the exact head with
  `eng run --by <id> -- <cmd>` (`npm test`, the CLI against a scratch repo, property tests), then records
  `eng verdict PASS|FAIL --by <id> --pr <n>`. The verdict carries the runs: command, exit code, output and SHA. A PASS
  counts only with passing runs on its commit. A model review (`--review`) is the required check only when every changed
  file is docs or policy text (`verification.review_only_paths`), and optional otherwise. That posts an `eng-verdict/v1`
  PR comment (head SHA, verifier, method, runs) and the `verdict` status.
- **Stop one PR:** add the `hold` label. **Stop all:** `gh workflow disable self-merge.yml`.
- **Undo:** `gh pr revert <n>` (one step: opens the revert PR, which goes through the same gates).

Details, the checker command and the GitHub settings: [docs/self-merge.md](docs/self-merge.md).

`eng merge` (v0.10.0, `merge.auto`) is the strict auto-merge gate this package ships for other repos. It is not live
here: `templates/merge-auto/` holds its workflows, and switching eng-standard to it needs Matt's settings change and a
PR that removes `self-merge.yml` in the same change. Until then `self-merge.yml` is the only merge path.
