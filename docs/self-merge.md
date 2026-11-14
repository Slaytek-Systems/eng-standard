# eng-standard self-merge

Design A from the 19 Oct 2026 merge discussion, applied to eng-standard itself. risk:high PRs self-merge too, after
counted PASSes on the exact head from `ship.high_risk.verifiers` (default 2) distinct verifiers. Verification tooling
decides, not who ran it (Matt, 6 Nov 2026; Core nd716pq0vffa13z4c99e09552x8hqwp3): the builder may verify its own work.
Rule summary: [AGENTS.md](../AGENTS.md).

## Pieces

| Piece | Where | What it does |
|---|---|---|
| Merge rule | `eng.config.yml` (`merge`, `ship`), `AGENTS.md` | risk:low after one counted PASS, risk:high after counted PASSes from N distinct verifiers (default 2), nobody bypasses |
| Risk label | `.github/workflows/risk-label.yml` → `scripts/pr-gate.mjs label` → `lib/risk.mjs` | On PR open, push, reopen, ready and edit (incl. retarget to main): `risk:high` if any changed path (or a rename's old path) matches `ship.high_risk.paths`, else `risk:low`. `package.json` / `package-lock.json` count only when more than the version changed. Runs main's code (`pull_request_target`, no PR checkout) so a PR cannot relabel itself |
| Verdict comment | `eng verdict ... --pr <n>` (`bin/eng.mjs`) | Posts an `eng-verdict/v1` PR comment with the record as JSON: head SHA, patch-id, result, by. Self-merge reads verdicts from these comments |
| Verdict status | `eng verdict ... --pr <n>` / `eng verdict status --pr <n>` (`bin/eng.mjs`) | Posts commit status `verdict` (success/failure) on the PR's exact head SHA from `eng verdict check --pr <n>`, which counts this clone's records and the PR's trusted `eng-verdict/v1` comments for that head (self-merge's parse and `verifier_logins` rules). The ruleset requires it |
| Run in progress | `eng run --by <id> -- <cmd>` (`lib/run.mjs`) | Sets commit status `eng-run/<id>/<command hash>-<run id>` pending on the run's commit, then success or failure when it ends; each run has its own context. The description says `eng run <id>: running` or `finished, exit N; not a merge check`. Self-merge does not count `<id>`'s PASS while one is pending |
| Self-merge | `.github/workflows/self-merge.yml` → `scripts/pr-gate.mjs merge` → `lib/self-merge.mjs` | On events only (below) and on dispatch. Skips everything if main's `test` is running (no run yet: dispatches `ci.yml`). Then checks the event's PR, reads every rule again, squash-merges it with `sha=<head>`, deletes its branch and dispatches `ci.yml` on main (the post-merge check) |
| Auto-revert | `scripts/pr-gate.mjs merge` on a red main | Opens `auto-revert/<sha12>` from `github-actions[bot]`: one commit on top of the red tip with the tip's parent tree, so it is the exact inverse. While main is red only that PR is considered, and only while it is still that exact inverse |
| Undo | `gh pr revert <n>` | Opens a revert PR |

Self-merge merges a PR only when **all** hold:

- Base `main`, branch in this repo (no forks), not draft, no `hold` label, and a `risk:low` or `risk:high` label.
- The head contains main's tip: `compare/<tip>...<head>` reports `behind_by: 0`.
- The latest `test` check run (GitHub Actions) is success on the head SHA, and the `verdict` status is success on it.
- The verdict comments pass the tier's rule. First the trust policy (below) drops every untrusted comment. Then only
  comments whose `sha` is the head SHA count. Who wrote the change plays no part. Each
  verifier's latest comment counts, and any FAIL among them refuses the merge. A PASS counts only as verification:
  passing runs on its own commit (`lib/verification.mjs`). A review PASS (`--review`) counts only when every changed file
  matches `verification.review_only_paths` (docs and policy text). An incomplete file list counts as testable.
  - **risk:low** needs one counted PASS (or PASS+NOTES).
  - **risk:high** needs counted PASSes from `ship.high_risk.verifiers` (default 2) distinct verifiers (`by` names,
    for example two tools or lanes). A PR is risk:high if its label says so or the files recomputed against
    `ship.high_risk.paths` say so. Path patterns match raw names, newlines included (`glob2re` uses dotAll), for both
    a file's name and a rename's old name.
- A comment's time is its last edit (`max(created_at, updated_at)`) when deciding which verdict is a verifier's latest.
- No PASS counts from a verifier with an `eng-run/<id>/...` status pending on the head (Run guard, below).

GitHub lists at most 3,000 files for a PR. When the listed files fall short of the PR's `changed_files`, the PR is
risk:high and every file counts as testable. An incomplete list is never evidence.

There is no wait (Matt, 26 Oct 2026: "Merge as soon as it's verified; post-merge checks roll back breakage"). A PR
merges in the first run after its last rule goes green. A new push gives a new head SHA, so everything must go green
again for it. Just before the merge call the run reads the PR, main's tip and its `test` run, and every rule again. If
the head or main moved, or any rule now fails (a `hold` label, a FAIL verdict, a run in progress), it merges nothing. The merge call pins the head SHA. `ship.self_merge.hold_minutes` no
longer exists, and a config that sets it fails with a message saying so.

## Run guard (14 Nov 2026)

Decision nd7ebz69qb0c39691a3ab586t58j4qwc (Matt, 14 Nov 2026): the run guard, and no wait after a verdict. The 12 Nov
sweep found opencode-deepseek posting PASS and then its own FAIL on the same head three times, 1, 1 and 5.5 minutes
apart (#73 at 1f2a2af5, and #66 twice). Self-merge fired 33 s after the deciding PASS on #73. A PASS doesn't count while
that verifier's own run on the head is in progress. A PASS followed by a newly started probe's FAIL can still merge:
Matt accepted that gap knowingly, and the post-merge check and auto-revert stay the backstop.

- **A PASS does not count while its verifier still has a run in progress on the head.** `eng run --by <id> -- <cmd>`
  sets commit status `eng-run/<id>/<8 hex of the command>-<run id>` to `pending` on the run's commit when the command
  starts, and to `success` or `failure` when it ends (`lib/run.mjs`). The run id is random per run, so two runs by one
  verifier, even of the same command at once, never share a context, and one's end never clears the other. Self-merge
  reads every status on the head, every page of GitHub's list (a head can carry more than 100 contexts), and any run of
  `<id>` still in progress stops `<id>`'s PASS from counting (`runsInProgress()`, `verdictGate()`). A FAIL from that
  verifier still blocks. Only a clone whose `origin` is on github.com posts these. If GitHub refuses the post (an
  unpushed commit, no `gh` login), `eng run` says so on stderr and the run goes on, and that run holds nothing back.
- **The status says what it is.** The description reads `timeout 1800s; eng run <id>: running; not a merge check: <cmd>`,
  then `eng run <id>: finished, exit N; not a merge check: <cmd>`. GitHub keeps 140 characters, so the timeout comes first
  and only the tail (a long id or command) is ever cut. A failing run's status stays `failure`, so it shows red
  on the PR: that is the honest state of that run. It is a verifier's run, not a required check; the verdict, not the run
  status, says what the runs proved.
- **Who owns a run, and who can end it.** A run's owner is the GitHub account that posted the first `pending` status on
  its context (the lowest GitHub status id). The run is in progress until an end (`success`, `failure` or `error`) on that
  context with a higher status id, posted by its owner or by a login in `ship.self_merge.verifier_logins`; a listed login
  can end any run, whoever owns it. Times never order rows: GitHub stamps them to the second, so two rows in one second
  would tie. A status on that context from any other account changes nothing: it does not start, end,
  extend or shorten the run, and its description is not read. So a collaborator cannot release a verifier's PASS by
  posting `success`, or a `pending` with a short timeout and then `success`, on its context. A run row with no creator
  (GitHub shows none for a deleted account) has no owner, so it does not parse and refuses every merge on that head. What
  this does not protect: anyone with push access
  can post a `pending` status on a new `eng-run/<id>/...` context and hold `<id>`'s PASS back until its deadline, as anyone
  with push access can add the `hold` label. A status can hold a PASS back; it never makes one count.
- **A run whose `eng` died stops counting at its deadline.** The deadline is the time GitHub recorded the owner's first
  pending status plus the budget timeout that description starts with (1800 s by default, `--budget timeout=...` sets
  it) plus 5 minutes. A pending status whose timeout cannot be read has no deadline: no default stands in for a budget
  that could be longer, so it holds until its owner or a listed login ends it. `eng run`'s budget stops a command at its timeout and then posts its end, so a run still alive never reaches its
  deadline; only a run whose `eng` process was killed (SIGKILL, a lost machine) is still pending then. The skip reason
  names the context and its deadline. To release it sooner, the verifier ends it knowingly with the same `gh` login that
  ran it: `gh api -X POST repos/<owner>/<repo>/statuses/<sha> -f state=error -f context=<context> -f description='cleared
  by hand: the run died'`. A finished `eng-run/...` status, that one included, runs self-merge for its head. A dead run
  that reaches its deadline posts nothing, so then run `gh workflow run self-merge.yml -f pr=<n>`, or wait for the PR's
  next event. Re-running the command does not clear it: the new run has its own context.
- **A status row is well-formed, or self-merge refuses the merge** (decision nd71xqrdrqemzemfahkpcyvyz18j5gp8, 14 Nov
  2026). `decide()` parses every row on every page once, up front (`parseStatuses()`), before any rule reads one, and
  names the first bad row in the skip reason. No row is skipped: a skipped row could be a run's pending start. Every row,
  on any context, needs all of these, or the merge is refused:

  | Field | Required shape |
  | --- | --- |
  | the row | a JSON object |
  | `id` | a positive whole number (GitHub's status id), unique in the list |
  | `state` | `pending`, `success`, `failure` or `error` |
  | `context` | a string with something besides space in it (the run rule below) |
  | `created_at`, `updated_at` | ISO 8601 times, such as `2026-11-13T20:33:08Z` |
  | `creator` | an object with a non-blank `login`. On a context that is not a run it may be `null`, which is how GitHub shows a deleted account. A run row needs the login: the run rule reads it |
  | `description` | a string or `null` |

  Other fields (`target_url`, `url`, `node_id`, `avatar_url`) are not read, and `null` is fine. The `null` creator call
  rests on real rows: the 75 statuses on the heads of the last 40 merged PRs here are all `verdict` rows with a
  creator, and GitHub documents `null` for an account that no longer exists. Refusing a `null` creator off a run would
  block a head over a field no rule reads. Rows are ordered by status id only, and the `verdict` status is the row
  with the highest id on that context. A row's time is read only for a run's deadline against now.

  A context looks like a run's when, folded to NFKC lower case with everything but letters and digits removed, it starts
  with `engrun`. That covers `eng-run/` with surrounding space, another case, another separator (`eng_run`, `eng run`,
  `eng-run:`) and a missing or extra segment. It parses in full only as `eng-run/<id>/<8 lowercase hex>-<run id>`, where
  `<id>` is one segment with no space and the run id is letters and digits. The rule is wide on purpose:
  a CI context that happens to start with `engrun` (say `engrunner/ci`) refuses too, and needs a rename. A false refusal
  costs a rename or a new commit (a status cannot be deleted); a skipped run row could merge. `eng run` refuses a `--by`
  that cannot fill `<id>` (a `/` or a space in it) before it runs anything, so eng never posts a row its own gate refuses.

A PR held back by a run in progress needs no dispatch: when the run ends, its `eng-run/...` status (posted with the
verifier's own token, so it starts workflows) runs self-merge for that head.

## Events

Self-merge has no schedule. Each event below starts one run. Runs share one concurrency group with `queue: max`, so they
run one at a time in arrival order, up to 100 waiting, and a newer run never replaces a waiting one. GitHub cancels a run
that arrives while 100 are waiting. It shows as cancelled in Actions; `gh workflow run self-merge.yml -f pr=<n>` runs
that PR again.

| Event | PRs it looks at |
|---|---|
| `workflow_run`: `ci` completed on a PR | that PR |
| `workflow_run`: `ci` completed on main after a push or a manual dispatch | every open PR (main's state changed) |
| `issue_comment` created or edited, body starts with `<!-- eng-verdict/v1 -->` | that PR |
| `status` with context `verdict` | the open PR whose head is that SHA |
| `status` with context `eng-run/...` and state other than `pending` (an `eng run --by` ended) | the open PR whose head is that SHA |
| `pull_request_target` labeled, unlabeled, ready_for_review, or edited with a base change (retargeted) | that PR |
| `workflow_dispatch` | input `pr`, or every open PR |
| `workflow_dispatch` from `ci.yml` job `start-self-merge` | every open PR |

`eng verdict --pr` posts the comment before the status, so a run started by the comment can see no `verdict` status
yet. The status event starts another run that sees both.

A `ci` run that self-merge dispatches with `GITHUB_TOKEN` (the post-merge check on main, or an auto-revert branch)
fires no `workflow_run`. GitHub does not start workflows from `GITHUB_TOKEN` events, except `workflow_dispatch`. So
`ci.yml` job `start-self-merge` dispatches self-merge when such a run ends, pass or fail. That job comes from the
dispatched branch's own `ci.yml`. GitHub fires no `workflow_run`, `check_run` or `check_suite` event for a run that
Actions created, so no trusted callback exists apart from it without a timer or a non-`GITHUB_TOKEN` credential. One
case has no callback: an auto-revert whose inverse restores a `ci.yml` without `start-self-merge` (the revert of the PR
that added it). Self-merge then says so in the revert PR's body. If its verdicts land before its `test` finishes, run
`gh workflow run self-merge.yml -f pr=<n>` once `test` is green.

Every one of these runs uses main's copy of `self-merge.yml` and main's code. Nothing from a PR is checked out or run.

**Trust policy** (`trusted()` in `lib/self-merge.mjs`, applied inside `decide()` before any verdict counts or
supersedes another). The repo is public, so anyone can post a comment that looks like a verdict.

- Only comments whose GitHub `author_association` is `OWNER`, `MEMBER` or `COLLABORATOR` count.
- When `ship.self_merge.verifier_logins` (a list of GitHub logins, in main's `eng.config.yml`) is set, only those
  logins may post verdicts. This guards against forged comments. It is not a rule about who wrote the change.
- A verifier is its `by` name either way. Each verifier's latest verdict supersedes only its own.
- Verdict comments posted before 26 Oct 2026 carry `family` and `provider` fields. They still parse; the gate ignores
  those fields.

**Caveats until lock A.** These hold by design until required results come from CI or from one App the builder cannot
forge (lock A, a later change).

- The builder may certify its own risk:low PR for self-merge: no gate compares the verifier with the authors.
- The gate trusts the recorded run evidence. It checks each run's command, integer exit code, output and SHA, that the
  SHA is the exact head, and that every exit code is 0 for a PASS. It does not re-run the commands at merge time.
  `eng verdict` attaches only runs that `eng run --by` captured, but a hand-written comment from an account with
  write access would pass the same field checks.
- risk:high counts distinct `--by` names (`v.key ?? v.by`). One GitHub login that posts under two `--by` names counts
  as two verifiers. Verifiers are tools or lanes, not people.

**Residual.** eng-standard sets `verifier_logins: [Mattslayga]`, the one login that has posted verdicts here. Every agent
posts through that account, so it can still claim any `by`. A dedicated verifier login listed in `verifier_logins` closes this.

**What a PASS proves.** A verification PASS proves a recorded run on the exact commit, not a re-run at merge time. A review
PASS on docs-only changes (`verification.review_only_paths`) has no runs. Rendered `AGENTS.md`, `SHIPPING.md` and `eng doctor`
say so always. An App ID only names who posts a status, so no setting removes the line.

The controller is main's code and main's `eng.config.yml`. A PR's comments and commit messages are read only as data,
so a PR cannot change the rule it is judged by.

## The checker's command

Any thread may run it, the builder included: what counts is what ran on the exact head, not who ran it.

```sh
# inputs: <n> PR number, <id> the verifier's name (a tool, lane or thread id),
#         <evidence> Core note id (or path) with what it checked
git fetch origin main && gh pr checkout <n> && git pull --ff-only && npm ci
node bin/eng.mjs run --by <id> -- npm test  # one run per check: tests, the CLI on a scratch repo, property tests
node bin/eng.mjs verdict PASS --by <id> --evidence <evidence> --pr <n>     # or FAIL; attaches the rounds as evidence
# docs or policy text only: node bin/eng.mjs verdict PASS --by <id> --review --evidence <evidence> --pr <n>
```

`eng run` runs in a private worktree of the exact commit. Git puts tracked files only there, so when every lockfile at
that commit, workspaces included, matches the checkout's byte for byte, eng mounts each of the checkout's `node_modules`
folders there read-only with `fuse-overlayfs` (the `npm ci` above installs them). The run's writes stay in its own layer
and never reach the checkout. When a lockfile differs, the checkout has no `node_modules`, or `fuse-overlayfs` is missing,
eng says so and the command installs the dependencies itself (`sh -c 'npm ci && npm test'`).

Running the change replaces most model review rounds and spends fewer tokens. A model review (`interrogate` or one
reviewer) stays available. It is required only for text no check can run, and optional on a high-risk change at the
builder's or lead's discretion.

A risk:high PR needs counted PASSes from `ship.high_risk.verifiers` (default 2) distinct verifiers. `--pr` records the verdict (a git note on the exact head), posts it as an `eng-verdict/v1` PR comment, and
then posts
`gh api repos/{owner}/{repo}/statuses/<head-sha> -f state=success|failure -f context=verdict`. It refuses to run when
local HEAD is not the PR's live head or the tree is dirty, and posts `failure` when no PASS counts (no runs, a failing
run, or a review on testable code) or a verifier's latest verdict is FAIL. Every new head, a clean rebase or a
message-only amend included, needs a new run and verdict: a verdict counts only for the exact commit it ran on.
Running the PR's own `bin/eng.mjs` is safe for risk:low PRs because `bin/**` is risk:high.

## Post-merge check and auto-revert

Each merge dispatches `ci.yml` on main, and `ci.yml` starts self-merge when that run ends. When main's `test` is red
and the tip is a squash merge of a PR, self-merge creates `auto-revert/<sha12>` through the git data API (a commit whose parent is the tip and whose tree
is the tip's parent tree), opens a PR from it as `github-actions[bot]`, sets its risk label (risk-label.yml does not
run for bot PRs) and dispatches `ci.yml` on the branch. It never reverts a revert and never reverts a tip that is not a
PR merge; it prints "escalate to Matt" instead. The revert PR gets verdicts like any PR. Unlike PR #20's gate, there is
no verdict-free path for it, because the ruleset requires the `verdict` status.

GitHub refuses the PR unless Actions may create pull requests (Settings > Actions > General). The run then fails,
names the pushed branch, and Matt either allows it or opens the branch as a PR.

## Undo

`gh pr revert <n>` opens a PR that reverts the squash commit. It is classed like the original (a low PR's revert is low)
and needs `test` plus a `verdict` like any PR. Self-merge merges it once both are green, or Matt can merge it by hand.

## GitHub settings (apply only after this PR merges)

Matt (admin) runs these once. A user-owned public repo supports repository rulesets on the free plan; `bypass_actors`
can be empty (OrganizationAdmin does not apply to personal repos), so the rules bind Matt too. Matt can still edit or
delete the ruleset as the repo admin; that is the only way around it. Merge queue is not available (user-owned repo).

```sh
R=Slaytek-Systems/eng-standard

# 1. Labels the workflows use
gh label create risk:high --repo $R --color B60205 --force --description "Needs counted PASSes on the exact head from N distinct verifiers"   # --force updates an existing label
gh label create risk:low --repo $R --color 0E8A16 --description "Self-merges after test + verdict"
gh label create hold     --repo $R --color FBCA04 --description "Stops self-merge for this PR"

# 2. Merge settings: squash only, delete head branches (GitHub then retargets stacked PRs to main)
gh api -X PATCH repos/$R -F allow_squash_merge=true -F allow_merge_commit=false -F allow_rebase_merge=false -F delete_branch_on_merge=true

# 3. Ruleset on main: PRs only, squash only, require test (GitHub Actions app 15368) + verdict, no deletion, no force-push, no bypass
gh api -X POST repos/$R/rulesets --input - <<'JSON'
{
  "name": "main: test + verdict, squash only, no bypass",
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
        "required_status_checks": [ { "context": "test", "integration_id": 15368 }, { "context": "verdict" } ] } }
  ]
}
JSON

# 4. Check
gh api repos/$R/rules/branches/main -q '.[].type'
gh workflow run self-merge.yml --repo $R -f dry_run=true     # first run: report only
```

## Known limits

- Every agent and Matt share the `Mattslayga` account, so GitHub cannot tell who posted `verdict` or a verdict
  comment, and a comment's `by` is self-declared. The runs it carries are the evidence. A dedicated verifier login
  (GitHub App) would let the ruleset pin `verdict` to that app, as it pins `test` to GitHub Actions.
- The labeller and self-merge only run from `main`, so they first act after this PR merges.
