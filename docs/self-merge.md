# eng-standard self-merge

Design A from the 19 Oct 2026 merge discussion, applied to eng-standard itself. **CI is the verifier** (Matt, 28 Oct
2026): every PR needs a successful run of main's `verify.yml` on its exact head commit. risk:high PRs also need agent
review: PASS comments from `ship.high_risk.verifiers` (default 2) independent reviewers with distinct identities.
Independence is judged by identity (26 Oct 2026).

Why: a verdict comment's independence rested on a self-declared `--by` string posted from Matt's own account, so it
could be faked. A CI run whose workflow code the PR cannot edit is a re-runnable program, not an agent's opinion (v2). Rule summary: [AGENTS.md](../AGENTS.md).

## Pieces

| Piece | Where | What it does |
|---|---|---|
| Merge rule | `eng.config.yml` (`merge`, `ship`), `AGENTS.md` | Every PR: main's verify run passed on the exact head. risk:high also: review PASSes from N distinct independent identities (default 2). Nobody bypasses |
| Verifier | `.github/workflows/verify.yml` | On `pull_request_target` (opened, synchronize, reopened, ready_for_review), so GitHub loads main's copy of the file. Checks out `pull_request.head.sha` with a read-only token, no secrets, no cache, `persist-credentials: false`, and runs `npm ci && npm test` and `eng --help`. Skips forks |
| Risk label | `.github/workflows/risk-label.yml` → `scripts/pr-gate.mjs label` → `lib/risk.mjs` | On PR open, push, reopen, ready and edit (incl. retarget to main): `risk:high` if any changed path (or a rename's old path) matches `ship.high_risk.paths`, else `risk:low`. `package.json` / `package-lock.json` count only when more than the version changed. Runs main's code (`pull_request_target`, no PR checkout) so a PR cannot relabel itself |
| Review verdict comment | `eng verdict ... --pr <n>` (`bin/eng.mjs`) | Posts an `eng-verdict/v1` PR comment with the record as JSON: head SHA, patch-id, result, by. Self-merge reads these as **review** for risk:high only |
| Verdict status | `eng verdict ... --pr <n>` (`bin/eng.mjs`) | Still posts commit status `verdict`. Nothing gates on it any more; the ruleset should require `verify` instead (settings below) |
| Self-merge | `.github/workflows/self-merge.yml` → `scripts/pr-gate.mjs merge` → `lib/self-merge.mjs` | On events only (below) and on dispatch. Skips everything if main's `test` is running (no run yet: dispatches `ci.yml`). Then checks the event's PR, reads every rule again, squash-merges it with `sha=<head>`, deletes its branch and dispatches `ci.yml` on main (the post-merge check) |
| Auto-revert | `scripts/pr-gate.mjs merge` on a red main | Opens `auto-revert/<sha12>` from `github-actions[bot]`: one commit on top of the red tip with the tip's parent tree, so it is the exact inverse. While main is red only that PR is considered, and only while it is still that exact inverse |
| Undo | `gh pr revert <n>` | Opens a revert PR |

Self-merge merges a PR only when **all** hold:

- Base `main`, branch in this repo (no forks), not draft, no `hold` label, and a `risk:low` or `risk:high` label.
- The head contains main's tip: `compare/<tip>...<head>` reports `behind_by: 0`.
- **Verify** (`verifyGate()` in `lib/self-merge.mjs`). The latest run of `verify.yml` listed for the head SHA
  (`actions/workflows/verify.yml/runs?head_sha=<head>&event=pull_request_target`) has `path`
  `.github/workflows/verify.yml`, `event` `pull_request_target`, `head_sha` equal to the PR's current head, and
  conclusion success. Each part closes a forgery:
  - `event == pull_request_target`: GitHub runs main's copy of the file for that event, so the PR cannot change the
    steps. A PR can edit `verify.yml` on its branch, but that copy only runs on `pull_request`, which never counts.
  - `path`: another workflow (or one the PR adds) with a job named `verify` never counts.
  - `head_sha`: a pass on an older push never counts; a new push needs a new run.
  - Verdict comments and the `verdict` status are not read here, so a forged comment alone merges nothing.
- **risk:low** needs nothing more.
- **risk:high** also needs review. The review verdict comments pass the tier's rule. First the trust policy (below) drops every untrusted comment. Then only
  comments whose `sha` is the head SHA count. A comment whose identity (`by`, or the login under `verifier_logins`)
  equals an author's identity (`Agent:` id, commit author or committer email, or GitHub login) never counts. Each
  verifier's latest comment counts, and any FAIL among them refuses the merge.
  - risk:high needs PASSes (or PASS+NOTES) from `ship.high_risk.verifiers` (default 2) independent verifiers with distinct
    identities. A PR is risk:high if its label says so or the files recomputed against
    `ship.high_risk.paths` say so. Path patterns match raw names, newlines included (`glob2re` uses dotAll), for both
    a file's name and a rename's old name.
- A comment's time is its last edit (`max(created_at, updated_at)`) when deciding which verdict is a verifier's latest.

GitHub lists at most 3,000 files and 250 commits for a PR. When the listed files fall short of the PR's
`changed_files`, the PR is risk:high; when the listed commits fall short of its `commits`, the authors are unknown and
the PR is skipped. An incomplete list is never evidence.

There is no wait (Matt, 26 Oct 2026: "Merge as soon as it's verified; post-merge checks roll back breakage"). A PR
merges in the first run after its last rule goes green. A new push gives a new head SHA, so everything must go green
again for it. Just before the merge call the run reads the PR, main's tip and its `test` run, and every rule again. If
the head or main moved, or any rule now fails (a `hold` label, a FAIL verdict), it merges nothing. The merge call pins
the head SHA. `ship.self_merge.hold_minutes` no longer exists, and a config that sets it fails with a message saying so.

## Events

Self-merge has no schedule. Each event below starts one run. Runs share one concurrency group with `queue: max`, so they
run one at a time in arrival order, up to 100 waiting, and a newer run never replaces a waiting one. GitHub cancels a run
that arrives while 100 are waiting. It shows as cancelled in Actions; `gh workflow run self-merge.yml -f pr=<n>` runs
that PR again.

| Event | PRs it looks at |
|---|---|
| `workflow_run`: `ci`, `verify` or `risk-label` completed on a PR (risk-label labels with `GITHUB_TOKEN`, which fires no `labeled` event) | that PR |
| `workflow_run`: `ci` completed on main after a push or a manual dispatch | every open PR (main's state changed) |
| `issue_comment` created or edited, body starts with `<!-- eng-verdict/v1 -->` | that PR |
| `pull_request_target` labeled, unlabeled, ready_for_review, or edited with a base change (retargeted) | that PR |
| `workflow_dispatch` | input `pr`, or every open PR |
| `workflow_dispatch` from `ci.yml` job `start-self-merge` | every open PR |

The `verify` run on a PR comes from `pull_request_target`, so it also lists the PR in `workflow_run.pull_requests`.

A `ci` run that self-merge dispatches with `GITHUB_TOKEN` (the post-merge check on main, or an auto-revert branch)
fires no `workflow_run`. GitHub does not start workflows from `GITHUB_TOKEN` events, except `workflow_dispatch`. So
`ci.yml` job `start-self-merge` dispatches self-merge when such a run ends, pass or fail. That job comes from the
dispatched branch's own `ci.yml`. GitHub fires no `workflow_run`, `check_run` or `check_suite` event for a run that
Actions created, so no trusted callback exists apart from it without a timer or a non-`GITHUB_TOKEN` credential. One
case has no callback: an auto-revert whose inverse restores a `ci.yml` without `start-self-merge` (the revert of the PR
that added it). Self-merge then says so in the revert PR's body. If its verdicts land before its `test` finishes, run
`gh workflow run self-merge.yml -f pr=<n>` once `test` is green.

Every one of these runs uses main's copy of `self-merge.yml` and main's code. Nothing from a PR is checked out or run.
(`verify.yml` does run the PR's code, on main's workflow, with a read-only token: that is its job.)

A PR opened with `GITHUB_TOKEN` (the auto-revert) fires no `pull_request_target`, so it gets no verify run until Matt
closes and reopens it (a user event). This is a known gap; a follow-up could dispatch a main-owned verifier for it.

**Trust policy** (`trusted()` in `lib/self-merge.mjs`, applied inside `decide()` before any verdict counts or
supersedes another). The repo is public, so anyone can post a comment that looks like a verdict.

- Only comments whose GitHub `author_association` is `OWNER`, `MEMBER` or `COLLABORATOR` count.
- When `ship.self_merge.verifier_logins` (a list of GitHub logins, in main's `eng.config.yml`) is set, only those
  logins count. The identity is the login, whatever `by` the comment claims, and each login is one verifier for
  superseding and for counting distinct identities.
- Without it, a verifier's identity is its `by` field.
- Verdict comments posted before 26 Oct 2026 carry `family` and `provider` fields. They still parse; the gate ignores
  those fields.

**Residual.** eng-standard has no `verifier_logins` yet. Every agent posts through Matt's account, so a comment with
write access can claim any `by`. Separate verifier identities listed in `verifier_logins` close this.

The controller is main's code and main's `eng.config.yml`. A PR's comments and commit messages are read only as data,
so a PR cannot change the rule it is judged by.

## The checker's command

Run by a fresh T3 thread that Eng Manager launches. It must not have written any commit in the PR, and its identity
(`--by`) must differ from every author identity in the PR's commits.

```sh
# inputs: <n> PR number, <id> the checker's own identity (e.g. its T3 thread id),
#         <evidence> Core note id (or path) with what it checked
git fetch origin main && gh pr checkout <n> && git pull --ff-only
npm ci && npm test                      # plus the review its brief asks for
node bin/eng.mjs verdict PASS --by <id> --evidence <evidence> --pr <n>     # or FAIL
```

A risk:high PR needs this from `ship.high_risk.verifiers` (default 2) verifiers with distinct identities. `--pr` records the verdict (git note bound to the patch-id), posts it as an `eng-verdict/v1` PR comment, and
then posts
`gh api repos/{owner}/{repo}/statuses/<head-sha> -f state=success|failure -f context=verdict`. It refuses to run when
local HEAD is not the PR's live head or the tree is dirty, and posts `failure` when the only verdicts are by an author
identity, or the latest independent verdict is FAIL. After a push that keeps the patch-id (a clean rebase),
`node bin/eng.mjs verdict status --pr <n>` re-posts without a new review; a changed patch needs a new verdict.
Running the PR's own `bin/eng.mjs` is safe for risk:low PRs because `bin/**` is risk:high.

## Post-merge check and auto-revert

Each merge dispatches `ci.yml` on main, and `ci.yml` starts self-merge when that run ends. When main's `test` is red
and the tip is a squash merge of a PR, self-merge creates `auto-revert/<sha12>` through the git data API (a commit whose parent is the tip and whose tree
is the tip's parent tree), opens a PR from it as `github-actions[bot]`, sets its risk label (risk-label.yml does not
run for bot PRs) and dispatches `ci.yml` on the branch. It never reverts a revert and never reverts a tip that is not a
PR merge; it prints "escalate to Matt" instead. The revert PR needs a verify run on its head (close and reopen it to
start one, see Events) and, being risk:high when it touches high-risk paths, review like any PR.

GitHub refuses the PR unless Actions may create pull requests (Settings > Actions > General). The run then fails,
names the pushed branch, and Matt either allows it or opens the branch as a PR.

## Undo

`gh pr revert <n>` opens a PR that reverts the squash commit. It is classed like the original (a low PR's revert is low)
and needs a verify pass (plus review if risk:high) like any PR. Self-merge merges it once those hold, or Matt can merge it by hand.

## GitHub settings (apply only after this PR merges)

Matt (admin) runs these once. A user-owned public repo supports repository rulesets on the free plan; `bypass_actors`
can be empty (OrganizationAdmin does not apply to personal repos), so the rules bind Matt too. Matt can still edit or
delete the ruleset as the repo admin; that is the only way around it. Merge queue is not available (user-owned repo).

```sh
R=Mattslayga/eng-standard

# 1. Labels the workflows use (risk:high already exists)
gh label create risk:low --repo $R --color 0E8A16 --description "Self-merges after verify passes"
gh label create hold     --repo $R --color FBCA04 --description "Stops self-merge for this PR"

# 2. Merge settings: squash only, delete head branches (GitHub then retargets stacked PRs to main)
gh api -X PATCH repos/$R -F allow_squash_merge=true -F allow_merge_commit=false -F allow_rebase_merge=false -F delete_branch_on_merge=true

# 3. Ruleset on main: PRs only, squash only, require test + verify (GitHub Actions app 15368), no deletion, no force-push, no bypass
gh api -X POST repos/$R/rulesets --input - <<'JSON'
{
  "name": "main: test + verify, squash only, no bypass",
  "target": "branch",
  "enforcement": "active",
  "bypass_actors": [],
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "pull_request", "parameters": {
        "allowed_merge_methods": ["squash"],
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": false,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": false } },
    { "type": "required_status_checks", "parameters": {
        "strict_required_status_checks_policy": false,
        "do_not_enforce_on_create": false,
        "required_status_checks": [ { "context": "test", "integration_id": 15368 }, { "context": "verify", "integration_id": 15368 } ] } }
  ]
}
JSON

# 4. Check
gh api repos/$R/rules/branches/main -q '.[].type'
gh workflow run self-merge.yml --repo $R -f dry_run=true     # first run: report only
```

## Known limits

- Every agent and Matt share the `Mattslayga` identity, so a review comment's `by` is self-declared. That is why review
  no longer decides whether a change works: verification is the CI run. Signed review verdicts were offered (28 Oct
  2026) and are undecided.
- The ruleset can pin `verify` to the GitHub Actions app, but a PR's own `pull_request` job named `verify` is also from
  that app, so the ruleset is only a backstop. The real check is self-merge's `verifyGate` (path and event).
- The labeller and self-merge only run from `main`, so they first act after this PR merges.
