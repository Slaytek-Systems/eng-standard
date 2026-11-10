<!--HDR-->
# SHIPPING.md: how a <REPO> change gets to production

Read this file first, before any other doc in this repo. It is the one shipping SOP. Humans and agents follow the same rules.
If another doc in this repo disagrees with this file, this file wins; fix the other doc in the same PR.
{{company_line}}
## 0. Fixed rules ({{fixed_scope}})

<REWRITE_RULE>
2. **No bypass.** Never use `gh pr merge --admin`, `--no-verify`, `enforce_admins` toggles, ruleset edits or any other bypass.{{bypass_guard}} If the only way through is a bypass, stop and report it as a GAP.
3. **Verification tooling decides.** Before merge, the repo's verification tooling runs the change against the exact commit and records a pass or fail. That tooling is its own dimension, so who runs it does not matter: {{builder_may}}. Each verifier the repo configures runs with `eng run --by <id> -- <cmd>`. The set is the repo's choice, for example the app on a running instance through the repo's `verify-<app>` skill, e2e (TesterArmy `e2e` where configured), property and mutation tests, and formal checks (§2). Each round records the command, exit code, output and commit SHA, and `eng verdict PASS|PASS+NOTES|FAIL --by <id>` attaches them as the evidence. Verification reduces the need for adversarial model review and uses tokens more efficiently. A model review of the diff (`eng verdict ... --review`, for example from `interrogate`) is the required check only when every changed file is text no check can run (`verification.review_only_paths`: docs and policy text by default). On other changes it is optional, at the builder's or lead's discretion, for example on a high-risk change: its FAIL blocks, but its PASS does not replace verification. A verdict counts only for the exact commit it ran on{{verdict_exact}}: patch-id ignores the message and whitespace, so a rebase, an amend or a merge-in of the base needs a new run and a new verdict. CI green is not a verdict.
4. **Skipped = failed.** A missing, skipped, soft-failed, cancelled or unknown check counts as failed.
5. **Flags.** In repos with a flag system, user-facing changes ship behind a flag, off by default. Deploy and release are separate steps.
6. **Database: additive first.** Schema/DB changes are additive and backward-compatible. Destructive changes use expand/contract over at least two deploys (add new shape → move code → backfill → stop reading old → remove old). Never run a `down()` migration as production rollback.
7. **Taste evidence.** UI work produces screenshots or a video of the actual flow for {{approves}}'s taste review, posted on the PR.
8. **Repeat mistakes become rules.** A finding seen twice becomes a lint, test or hook, proven against the original mistake.
9. **Merge owner is per repo.** There is no global merge rule. §3 below names who or what merges, with the exact command.
10. **State gaps plainly.** Where no allowed path exists, §7 says GAP. Do not invent a workaround.
11. **Reading a PR is not proof.** Reading a PR does not prove it is shippable. Only running it does: checks on the exact commit, the real app exercised, and evidence posted.
12. **Staging is not mandatory.** Prove changes on a throwaway per-PR or local environment; schema/data changes still get a dry run on a production-shaped copy where the repo has one.
13. **Verify in production.** Ship user-facing changes dark behind a flag, verify on internal/test accounts in prod, then widen; flag off is the first rollback.
14. **A red `<BASE>` is never called a flake without evidence.** Evidence means the failing log line and a reason it is nondeterministic. Re-run once only, to confirm. If it fails twice it is real: revert the merged PR or fix the cause; never re-run until green{{flake_why}}. After a squash merge, `eng verdict check` on `<BASE>` reports the PR head's verdict for the audit trail; it never counts a verdict for another commit.
15. **Plans and evidence are committed, never left only in `/tmp`.** A plan, repro, log excerpt or evidence file that a decision rests on goes into the repo (or the PR/issue) before the decision is reported. `/tmp` is scratch and is cleaned (§5); a path there is not evidence.
<TAIL_RULES>


## 1. Pick up and do work

To use any skill, read `.agents/skills/<name>/SKILL.md`; do not rely on description matching. The skill router in AGENTS.md (and the `eng-route` skill) is the fallback.

<SPAWN>

1. Branch from current `origin/<BASE>`.
2. Grill the plan before code (`grilling` skill). Architecture and engineering questions are answered first.
3. Edit loop: `<TEST>`.
4. Add a check for the behaviour in `.eng/checks/<id>.sh` that fails on base and passes on HEAD. `eng gate` runs it from then on, in CI too.

## 2. What must pass before merge (on the exact head SHA)

`<GATE>` runs every check in `verification.checks_dir` first (`flake_runs` times each), whatever `gates.required` says, then every required gate in `eng.config.yml` (`gates.required`). A failing, flaky or stale check fails the gate, whatever the verdict says. A skipped, missing or blocked gate is a failure. CI runs the checks as their own step (`eng gate checks`).<PR_CHECKS>
After merging `<BASE>` in, the head is a new SHA: it needs its own runs (`eng run --by <id> -- <cmd>`) and verdict.

**E2E is path-based on PRs** (`eng.config.yml` → `e2e.policy`). A PR runs e2e when it touches app code, routes, DB schema/migrations, deps/build config or CI, or is labelled `risk:high`. Docs-only, config-only (non-CI) and test-only PRs skip it: the `e2e` gate passes with `NOT REQUIRED` and the reason. Run `eng e2e --required` to see the decision and which file triggered it. A file no list matches runs e2e.
**`<BASE>` always runs the full e2e after every merge** (and nightly where enabled). That run is the backstop for what PRs skipped. A red e2e on `<BASE>` means the shipping manager reverts the merged PR immediately, before anything else merges; no fix-forward on `<BASE>`{{main_red_why}}.

**Flake rule for e2e.** A new or changed e2e test must pass <FLAKE_RUNS> consecutive runs (`eng.config.yml` → `e2e.flake_runs`) before it may be blocking: `eng e2e --flake-check`. All pass: blocking. All fail: a real failure, fix it. Mixed: flaky, so quarantine it as report-only (not a required check) and open an issue with the traces; it becomes blocking only after it passes <FLAKE_RUNS> in a row. Prove it bites before it blocks (`e2e-flow` skill).

**The required check is verification**{{verification_by}}. `eng verdict check` (gate `verdict`), self-merge and `eng merge gate` count a PASS only when it lists passing runs on its own commit, or when every changed file matches `verification.review_only_paths` and the PASS is a review. A missing verdict, a review-only PASS on testable code, or a PASS with a failing run fails the gate. A verdict recorded before this rule has no method and counts as a review.

**When to add formal verification.** Add a formal check when a bug would be costly and tests cannot cover every path: a state machine or protocol (merge flow, rollout, booking, retries), money (balances, billing, payouts), auth and permissions, and data migrations or other changes that rewrite stored data. Use the skill `formal.stateful` names for a flow that moves between states (default `statechart`: TLA+ checked by TLC) and the one `formal.other` names for other high-cost code (default `create-formal-verification-skill`). Once the repo has one, the verifier runs it with `eng run --by` like any other check.

**Required checks are not strict.** Branch rulesets require the gate checks but do NOT require branches to be up to date before merging. Safety comes from the full run on `<BASE>` after every merge plus an immediate revert on red. A verdict does not carry over: each new head needs its own run and verdict.

<RULESET>

## 3. Merge

- **Who merges:** <MERGE_OWNER> (set per repo in `eng.config.yml` → `merge`; there is no global rule).
- **Exact command:** `<MERGE_COMMAND>`.
- **Merge method:** <MERGE_METHOD>.
<SHIP>
## 4. Flags and database

- Flags file: `<FLAGS>`. New flags are added as `false`; `eng lint` rule `flags-default-off` enforces it.
- Migrations: `<MIGRATIONS>`. Additive only; `eng lint` rule `db-additive-only` rejects DROP / RENAME / destructive ALTER. Destructive change = expand/contract over two deploys.

## 5. {{disk_title}}

{{disk_story}}

- **Temp dirs.** Tests, e2e and fallow write only under the per-run dir `$ENG_TMP` (`<hygiene.scratch_root>/eng-<repo>-<runid>`; the scratch root is repo-owned, `~/.cache/eng/<repo>/scratch` by default, never bare `/tmp`). `eng gate` and `eng e2e` create it, point `ENG_TMP` and `TMPDIR` at it for every child, and remove it on exit, on failure and on SIGINT/SIGTERM/SIGHUP. Vitest picks it up through `globalSetup: ['./.eng/test-tmp.mjs']`. Test code never writes to bare `os.tmpdir()` or `/tmp`; `eng lint` rule `test-bare-tmpdir` flags it. Never install or copy `node_modules` into /tmp.
- **Worktrees.** When a thread settles or its PR merges, the author confirms its commits are pushed (`git status -sb` shows nothing ahead; `git log @{u}..` is empty), then removes its worktree from the main checkout with `git worktree remove <path>`. Without `--force`, git refuses a worktree with uncommitted changes.
- **Never delete unpushed or dirty worktrees.** Not with `git worktree remove --force`, not with `rm -rf`. Report them to the repo lead with the path, branch and what is unpushed or uncommitted.

**Clean up on merge or close** ({{cleanup_why}}).

- **Worktrees.** Use one worktree per PR and reuse it for every review round; do not make a fresh one per round. Delete the PR's task and review worktrees when it merges or closes (`git worktree remove <path>`; the push and clean checks above still apply).
- **Evidence.** Keep only logs, diffs, verdicts and screenshots. Never copy the repo, `node_modules`, binaries or databases into evidence. Delete local evidence dirs when the PR merges or closes; what a decision rests on is already in the repo or PR (rule 15).
- **No installs in review-only worktrees.** Do not run a `node_modules` install in a worktree that only reviews. Where an install is needed, use a shared pnpm or bun store with hard links.
- **One build cache per toolchain.** Share it across lanes and worktrees, never one per lane or worktree. Rust: one `CARGO_TARGET_DIR` or `sccache`, and `CARGO_INCREMENTAL=0` for agents.
- **Media off the box.** Walkthrough videos and other media go to Drive (or similar), with the link on the PR.
- **Temp dirs delete themselves** on exit, failure or signal, like `$ENG_TMP` above.

**Scratch, caches, containers and evidence** ({{scratch_why}}).

- **One round dir per round.** `eng run -- <cmd>` runs the command in a private 0700 worktree of the exact commit inside one round dir under `hygiene.scratch_root`, and a trap removes the round on exit, failure or signal. `eng run --keep` is the only persistent form (`eng run down <dir>`). Scripts write scratch only under `$ENG_SCRATCH` / `$ENG_TMP`, never bare `/tmp` (`eng lint` rule `script-bare-tmpdir`). Credentials stay in env or on stdin, never on disk (`credential-to-disk`).
- **One shared build cache per toolchain per repo** (`hygiene.caches`). eng exports `CARGO_TARGET_DIR` (+ `CARGO_INCREMENTAL=0`), `BUN_INSTALL_CACHE_DIR`, `ENG_VITE_CACHE_DIR` (vite.config sets `cacheDir` from it) and a stable `DENO_DIR` to every child. No per-run targets or caches in tmp (`cargo-target-tmp`, `deno-dir-unstable`).
- **Containers** run with `--rm`, or with `--label "$ENG_CONTAINER_LABEL"` and the run removes them with their volumes (`container-no-rm`). Never `docker volume prune -a` (`volume-prune-all`): it deletes other repos' data.
- **Evidence per PR.** e2e evidence lands in `<e2e.evidence_dir>/pr-<n>/<sha>/`; delete it when the PR merges or closes.
- **Runs are ephemeral by default** ({{ephemeral_why}}). Every local test, review and probe run behaves like {{sandbox}}: it is thrown away when it ends. Containers and volumes are removed, its temp folder is deleted, and no server keeps running. Running locally is no reason to keep anything. Only a permanent dev server may stay, and it must be marked: {{persist_marks}} (`hygiene.run_rules.ephemeral_runs.persist_label` / `persist_env`). `eng run <name>` (CI, and `eng gate` for each declared run) runs the command under a parent that tracks every descendant, with its own run id, TMPDIR, private `/tmp` (bubblewrap, where the host allows it), scratch dir and docker socket. The socket labels every container, volume and network the run creates, whether through the CLI, compose or an API client. Afterwards the check fails on any container, network, volume, temp entry or process the run left, and removes only what carries the run's label: containers (with the volumes Docker made for them), networks and processes. It never removes a volume by name; any other volume the run left is reported with the command to remove it. A run it cannot watch (no `python3`, or docker without the run's socket) is refused before it starts. It checks what is left, not flags, so nobody has to remember `--rm`. `eng run --here -- <cmd>` checks one command.
- **`eng doctor`** (gate `doctor`) fails a config that skips any of these: scratch root, the cache for each toolchain the repo uses, the Vite `cacheDir`, the container label, `evidence: per_pr`, and the disk rules.

**Four disk rules**{{disk_rules_by}} found that most writes were full private copies of something identical every run, which nothing read again. Each rule is a setting in `hygiene.disk_rules` with `mode: fail | warn | off` (default `fail`) and a check that enforces it. `eng doctor` fails a rule set to `off`.

- **Tests and proofs leave nothing behind** (`tests_leave_nothing`). `eng gate` gives each step its own `TMPDIR`/`ENG_TMP` and fails the step if anything is left in it. `eng run <name>` and `eng run --here -- <cmd>` do the same for one command, such as a proof script or a CI test step. The Node module compile cache is off for these commands (`NODE_DISABLE_COMPILE_CACHE=1`), because each worktree path writes a new entry that is never read.
- **No build caches inside evidence folders** (`no_cache_in_evidence`). `eng verdict check` and `eng e2e` fail when a marker file (`markers`, default `CACHEDIR.TAG`, which Cargo writes in every target and build dir) is under an evidence run dir. `eng lint` rule `cargo-target-per-run` flags a script that sets `CARGO_TARGET_DIR` or `CARGO_BUILD_BUILD_DIR` from a run dir, run id, scratch or mktemp path.
- **Pinned downloads are fetched once into a shared, checksummed cache** (`pinned_downloads`). eng exports the cache as `ENG_DOWNLOAD_CACHE` to every run. Fill `<cache>/<name>-<version>/` once, check the pinned SHA-256 on every use, and extract archives inside that dir. eng has no built-in check for it since 0.14.0: a repo that pins downloads checks them with its own command. `prepare: null` means the repo has no pinned downloads.
- **Evidence folders have a size budget** (`evidence_budget`, `max_mb`, default 100). `eng verdict check` and `eng e2e` fail when an evidence run dir (`<root>/<run>` or `<root>/pr-<n>/<sha>`, roots from `hygiene.evidence_roots`) is over budget. The check reports and never deletes.

## 6. CI hygiene

<CI_HYGIENE>

## 7. GAPS

1. Server-side enforcement (rulesets, required checks) is not applied by `eng` v0; `eng init` prints the advice in §2 to apply by hand. Local hooks are convenience; `--no-verify` skips them.
