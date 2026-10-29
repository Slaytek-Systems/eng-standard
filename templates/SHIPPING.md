<!--HDR-->
# SHIPPING.md: how a <REPO> change gets to production

Read this file first, before any other doc in this repo. It is the one shipping SOP. Humans and agents follow the same rules.
If another doc in this repo disagrees with this file, this file wins; fix the other doc in the same PR.
Company name: Slaytek Systems (never "Slaytek" alone).

## 0. Fixed rules (same in every Slaytek Systems repo; do not edit per repo)

1. **Rebase feature branches, never protected ones.** Feature branches are rebased into small ordered commits and onto the base (pstack Opening a PR), then pushed with `git push --force-with-lease`. Protected branches (`main` and any in `project.protected_branches`) are never rebased, force-pushed or deleted. Merges to `main` are squash merges.
2. **No bypass.** Never use `gh pr merge --admin`, `--no-verify`, `enforce_admins` toggles, ruleset edits or any other bypass. The devbox Safe YOLO hook blocks `gh pr merge --admin` as `production.mutate`. If the only way through is a bypass, stop and report it as a GAP.
3. **Independent verifier.** Before merge, an agent (or human) whose identity differs from every author's drives the change through the repo's `verify-<app>` skill and records `eng verdict PASS|PASS+NOTES|FAIL --by <id>` with its own identity. The verdict binds to the patch-id of base...head (pstack Shipping step 3): a rebase or a merge-in of the base that leaves the patch unchanged keeps the verdict; any change to the patch voids it. CI green is not a verdict. Commits carry an `Agent:` trailer so `eng verdict check` can tell author from verifier by identity.
4. **Skipped = failed.** A missing, skipped, soft-failed, cancelled or unknown check counts as failed.
5. **Flags.** In repos with a flag system, user-facing changes ship behind a flag, off by default. Deploy and release are separate steps.
6. **Database: additive first.** Schema/DB changes are additive and backward-compatible. Destructive changes use expand/contract over at least two deploys (add new shape → move code → backfill → stop reading old → remove old). Never run a `down()` migration as production rollback.
7. **Taste evidence.** UI work produces screenshots or a video of the actual flow for Matt's taste review, posted on the PR.
8. **Repeat mistakes become rules.** A finding seen twice becomes a lint, test or hook, proven against the original mistake.
9. **Merge owner is per repo.** There is no global merge rule. §3 below names who or what merges, with the exact command.
10. **State gaps plainly.** Where no allowed path exists, §7 says GAP. Do not invent a workaround.
11. **Reading a PR is not proof.** Reading a PR does not prove it is shippable. Only running it does: checks on the exact commit, the real app exercised, and evidence posted.
12. **Staging is not mandatory.** Prove changes on a throwaway per-PR or local environment; schema/data changes still get a dry run on a production-shaped copy where the repo has one.
13. **Verify in production.** Ship user-facing changes dark behind a flag, verify on internal/test accounts in prod, then widen; flag off is the first rollback.
14. **A red `<BASE>` is never called a flake without evidence.** Evidence means the failing log line and a reason it is nondeterministic. Re-run once only, to confirm. If it fails twice it is real: revert the merged PR or fix the cause; never re-run until green (motus MOT-338, 13 Oct 2026). After a squash merge, `eng verify maintain` and `eng verdict check` resolve the PR head's records on `<BASE>` by patch-id.
15. **Plans and evidence are committed, never left only in `/tmp`.** A plan, repro, log excerpt or evidence file that a decision rests on goes into the repo (or the PR/issue) before the decision is reported. `/tmp` is scratch and is cleaned (§5); a path there is not evidence.
16. **A red-`<BASE>` recovery must end in either `<BASE>` green or an explicit escalation.** Escalate to the repo lead (and Matt if the change is Matt-gated), stating the cause, the owner and the next step. A recovery thread may never just finish while `<BASE>` is still red (Motus f193b345, 14 Oct 2026: two recovery threads ended with main still red).
17. **Before reporting merge or ship status, read live state from GitHub.** PR merged?, merge SHA, `<BASE>`'s latest checks. Never report from memory or a failed command's output (`eng ship next` prints the live merged state and main checks). (Core Edge #257, 14 Oct 2026: a thread reported "no merge SHA yet" when the PR had merged at 5:28 AM AEDT as ec67f831.)
18. **Clean up on merge or close.** When a PR merges or closes, its worktrees and evidence are deleted. Reuse one worktree per PR, keep evidence to logs, diffs, verdicts and screenshots, share package stores and build caches, keep media off the box, and make temp dirs delete themselves (§5). (Devbox forensics, 17 Oct 2026: about 100 GB of agent leftovers.)
19. **Briefs live in Core.** Any brief one agent hands another (a builder, reviewer or verifier thread) is written to Core first, as a note in the repo's Core space tagged `brief`. The worker thread's prompt names the Core note id; it may paste the brief inline too. `/tmp` or any other scratch path is never the only copy; a local file is only a convenience copy of the Core note. A revision updates the same note (Core keeps the history); never create a second note such as r2. (Approved by Matt, 19 Oct 2026: verdicts and audits must see exactly what a builder was told, even after the devbox restarts or `/tmp` is cleaned.)
20. **Callback contract.** Scripts, CI jobs and T3 threads that wake a bot post only when work is done, blocked or needs a decision. No progress pings, no all-clears. The post is one line: `<status> <thread-id> <one short clause>`, where status is `done`, `blocked` or `needs-decision`. Detail goes in a Core note or file, named by its id. A woken bot reads only that payload and at most the last 2 messages of the named thread, never the whole history. If nothing needs a decision or reply, it exits without a message. (Approved by Matt, 19 Oct 2026.)
21. **Hand off by default.** Any coding or bulk job over about 20 steps goes to a T3 thread: a builder, plus an independent verifier as this standard already requires. The lead hands it off and ends its own run, then wakes on the rule-20 `done` or `blocked` callback. Leads check progress with cheap live-state checks (the verdict status, CI, `gh pr checks`, `gh pr view`), not by reading whole threads or diffs. Decisions for Matt and client-facing communication stay with the lead. (Approved by Matt, 19 Oct 2026. Tested first on Eng Manager's Fleet Control Tower webhook from 19 Oct; project leads switch on Wed 21 Oct 2026.)


## 1. Pick up and do work

To use any skill, read `.agents/skills/<name>/SKILL.md`; do not rely on description matching. The skill router in AGENTS.md (and the `eng-route` skill) is the fallback.

<SPAWN>

1. Branch from current `origin/<BASE>`.
2. Grill the plan before code (`grilling` skill). Architecture and engineering questions are answered first.
3. Edit loop: `<TEST>`.
4. Add a check for the behaviour in `.eng/checks/<id>.sh` and prove it: `eng verify create <id>` (fails on base, passes on HEAD, verdict pinned to the SHA as a git note).

## 2. What must pass before merge (on the exact head SHA)

`<GATE>` runs every required gate in `eng.config.yml` (`gates.required`). A skipped, missing or blocked gate is a failure.
After merging `<BASE>` in, the head is a new SHA: run `eng verify maintain` to re-verify on it.

**E2E is path-based on PRs** (`eng.config.yml` → `e2e.policy`). A PR runs e2e when it touches app code, routes, DB schema/migrations, deps/build config or CI, or is labelled `risk:high`. Docs-only, config-only (non-CI) and test-only PRs skip it: the `e2e` gate passes with `NOT REQUIRED` and the reason. Run `eng e2e-required` to see the decision and which file triggered it. A file no list matches runs e2e.
**`<BASE>` always runs the full e2e after every merge** (and nightly where enabled). That run is the backstop for what PRs skipped. A red e2e on `<BASE>` means the shipping manager reverts the merged PR immediately, before anything else merges; no fix-forward on `<BASE>` (motus #285, 13 Oct 2026).

**Flake rule for e2e.** A new or changed e2e test must pass <FLAKE_RUNS> consecutive runs (`eng.config.yml` → `e2e.flake_runs`) before it may be blocking: `eng e2e --flake-check`. All pass: blocking. All fail: a real failure, fix it. Mixed: flaky, so quarantine it as report-only (not a required check) and open an issue with the traces; it becomes blocking only after it passes <FLAKE_RUNS> in a row. Prove it bites before it blocks (`e2e-flow` skill).

**Required checks are not strict.** Branch rulesets require the gate checks but do NOT require branches to be up to date before merging. Safety comes from the full run on `<BASE>` after every merge plus an immediate revert on red, and the verdict carries over by patch-id.

<RULESET>

## 3. Merge

- **Who merges:** <MERGE_OWNER> (set per repo in `eng.config.yml` → `merge`; there is no global rule).
- **Exact command:** `<MERGE_COMMAND>`.
- **Merge method:** <MERGE_METHOD>.
<SHIP>
## 4. Flags and database

- Flags file: `<FLAGS>`. New flags are added as `false`; `eng lint` rule `flags-default-off` enforces it.
- Migrations: `<MIGRATIONS>`. Additive only; `eng lint` rule `db-additive-only` rejects DROP / RENAME / destructive ALTER. Destructive change = expand/contract over two deploys.

## 5. Disk hygiene (devbox disk hit 92%, 13 Oct 2026)

The shared devbox filled at ~8 GB/hour: per-run test dirs in /tmp were never deleted (Motus vitest/e2e 2-4 GB per run, 44 GB in total; Core Edge fallow-coverage/cli-home fixtures ~8 GB; a stray 34 GB /tmp/node_modules) and 118 T3 worktrees (~70 GB) were never removed when their threads finished.

- **Temp dirs.** Tests, e2e and fallow write only under the per-run dir `$ENG_TMP` (`<hygiene.scratch_root>/eng-<repo>-<runid>`; the scratch root is repo-owned, `~/.cache/eng/<repo>/scratch` by default, never bare `/tmp`). `eng gate` and `eng e2e` create it, point `ENG_TMP` and `TMPDIR` at it for every child, and remove it on exit, on failure and on SIGINT/SIGTERM/SIGHUP. Vitest picks it up through `globalSetup: ['./.eng/test-tmp.mjs']`. Test code never writes to bare `os.tmpdir()` or `/tmp`; `eng lint` rule `test-bare-tmpdir` flags it. Never install or copy `node_modules` into /tmp.
- **Stale temp dirs.** A run killed with SIGKILL cannot clean up. `eng clean` lists this repo's `eng-<repo>-*` dirs older than N hours (`--older-than`, default 6) whose process is gone; `eng clean --apply` deletes them.
- **Worktrees.** When a thread settles or its PR merges, the author confirms its commits are pushed (`git status -sb` shows nothing ahead; `git log @{u}..` is empty), then removes its worktree from the main checkout: `eng clean --worktrees --apply`. It removes only worktrees whose branch is merged into `origin/<BASE>` or deleted upstream, AND whose commits are all on the remote, AND that have no uncommitted changes. Everything else is reported, never deleted.
- **Never delete unpushed or dirty worktrees.** Not with `git worktree remove --force`, not with `rm -rf`. Report them to the repo lead with the path, branch and what is unpushed or uncommitted.
- `eng clean` is a dry run by default; read its output before adding `--apply`.

**Clean up on merge or close** (devbox forensics, 17 Oct 2026: about 100 GB of agent leftovers).

- **Worktrees.** Use one worktree per PR and reuse it for every review round; do not make a fresh one per round. Delete the PR's task and review worktrees when it merges or closes (`eng clean --worktrees --apply`; the push and clean checks above still apply).
- **Evidence.** Keep only logs, diffs, verdicts and screenshots. Never copy the repo, `node_modules`, binaries or databases into evidence. Delete local evidence dirs when the PR merges or closes; what a decision rests on is already in the repo or PR (rule 15).
- **No installs in review-only worktrees.** Do not run a `node_modules` install in a worktree that only reviews. Where an install is needed, use a shared pnpm or bun store with hard links.
- **One build cache per toolchain.** Share it across lanes and worktrees, never one per lane or worktree. Rust: one `CARGO_TARGET_DIR` or `sccache`, and `CARGO_INCREMENTAL=0` for agents.
- **Media off the box.** Walkthrough videos and other media go to Drive (or similar), with the link on the PR.
- **Temp dirs delete themselves** on exit, failure or signal, like `$ENG_TMP` above.

**Scratch, caches, containers and evidence** (v0.9.2; Warden's audit, Oct 2026: a motus proof script's mkdtemp in /tmp, Core Edge Rust targets in /tmp, equitus Deno caches per run, Docker anonymous volumes).

- **One round dir per round.** `eng launch -- <cmd>` and `eng verdict round -- <cmd>` run the command in a private 0700 worktree inside one round dir under `hygiene.scratch_root`, and a trap removes the round on exit, failure or signal. `eng launch --keep` is the only persistent form (`eng launch down <dir>`). Scripts write scratch only under `$ENG_SCRATCH` / `$ENG_TMP`, never bare `/tmp` (`eng lint` rule `script-bare-tmpdir`). Credentials stay in env or on stdin, never on disk (`credential-to-disk`).
- **One shared build cache per toolchain per repo** (`hygiene.caches`). eng exports `CARGO_TARGET_DIR` (+ `CARGO_INCREMENTAL=0`), `BUN_INSTALL_CACHE_DIR`, `ENG_VITE_CACHE_DIR` (vite.config sets `cacheDir` from it) and a stable `DENO_DIR` to every child. No per-run targets or caches in tmp (`cargo-target-tmp`, `deno-dir-unstable`).
- **Containers** run with `--rm`, or with `--label "$ENG_CONTAINER_LABEL"` and are removed with their volumes by `eng clean --containers --apply` (`container-no-rm`). Never `docker volume prune -a` (`volume-prune-all`): it deletes other repos' data.
- **Evidence per PR.** e2e evidence lands in `<e2e.evidence_dir>/pr-<n>/<sha>/`; `eng clean --evidence --apply` deletes merged or closed PRs' dirs and reports the rest.
- **`eng doctor`** (gate `doctor`) fails a config that skips any of these: scratch root, the cache for each toolchain the repo uses, the Vite `cacheDir`, the container label, `evidence: per_pr`, and the disk rules.

**Four disk rules** (approved by Matt, 30 Oct 2026; source: Core note nd79fdwd1p4hc5nk60j7rmbn518h6tsv). The 29 Oct disk audit found that most writes were full private copies of something identical every run, which nothing read again. Each rule is a setting in `hygiene.disk_rules` with `mode: fail | warn | off` (default `fail`) and a check that enforces it. `eng doctor` fails a rule set to `off`.

- **Tests and proofs leave nothing behind** (`tests_leave_nothing`). `eng gate` gives each step its own `TMPDIR`/`ENG_TMP` and fails the step if anything is left in it. `eng leave-nothing -- <cmd>` does the same for one command, such as a proof script or a CI test step. The Node module compile cache is off for these commands (`NODE_DISABLE_COMPILE_CACHE=1`), because each worktree path writes a new entry that is never read.
- **No build caches inside evidence folders** (`no_cache_in_evidence`). `eng evidence check` (gate `evidence`) and `eng e2e` fail when a marker file (`markers`, default `CACHEDIR.TAG`, which Cargo writes in every target and build dir) is under an evidence run dir. `eng lint` rule `cargo-target-per-run` flags a script that sets `CARGO_TARGET_DIR` or `CARGO_BUILD_BUILD_DIR` from a run dir, run id, scratch or mktemp path.
- **Pinned downloads are fetched once into a shared, checksummed cache** (`pinned_downloads`). `eng fetch <name> <version> <url> <sha256>` fills `<cache>/<name>-<version>/` once and checks the pinned SHA-256 on the fill and on every use. Extract archives inside that dir, then read or `--ro-bind` them from there. `eng downloads check` (gate `downloads`) runs `prepare` twice against one fresh cache. It fails when the second run writes to the cache, when a run dir holds a copy of a cached file, or when a cached file has no matching `.sha256`. `prepare: null` means the repo has no pinned downloads.
- **Evidence folders have a size budget** (`evidence_budget`, `max_mb`, default 100). `eng evidence check` and `eng e2e` fail when an evidence run dir (`<root>/<run>` or `<root>/pr-<n>/<sha>`, roots from `hygiene.evidence_roots`) is over budget. A proof harness runs `eng evidence check <run-dir>` after teardown and writes its PROVEN receipt only when it passes. The check reports and never deletes.

## 6. CI hygiene

<CI_HYGIENE>

## 7. GAPS

1. Server-side enforcement (rulesets, required checks) is not applied by `eng` v0; `eng init` prints the advice in §2 to apply by hand. Local hooks are convenience; `--no-verify` skips them.
