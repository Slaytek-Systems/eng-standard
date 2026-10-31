# Changelog

Versions follow the commit titles on `main` (`vX.Y.Z: ...`). Minor = new command, config or policy area; patch = rule or doc addition to an existing area. History before 0.7.1 is in `git log`.

## Unreleased (30 Oct 2026)

**Four disk rules** (approved by Matt, 30 Oct 2026; source: Core note nd79fdwd1p4hc5nk60j7rmbn518h6tsv). Each is a `hygiene.disk_rules` setting with a default, its allowed options, the Core source and a check. Modes are `fail | warn | off`, and every default is `fail`.

- `tests_leave_nothing`: `eng gate` gives each step a private `TMPDIR`/`ENG_TMP` and fails it on leftovers. New `eng leave-nothing -- <cmd>` does the same for one command.
- `no_cache_in_evidence` (`markers`, default `[CACHEDIR.TAG]`): new `eng evidence check` (gate `evidence`) and `eng e2e` fail on a cache marker in an evidence run dir. New lint rule `cargo-target-per-run`.
- `pinned_downloads` (`cache`, `prepare`): new `eng fetch` fills a shared cache once with a SHA-256 check on every use, and eng exports the cache as `ENG_DOWNLOAD_CACHE`. New `eng downloads check` (gate `downloads`) runs `prepare` twice, the second time with no network through bubblewrap, and fails closed without it. It fails on a second download, a copy or extracted archive member in the run dir, or a cached file that is neither a checksummed artifact nor extracted beside one.
- `evidence_budget` (`max_mb`, default 100): `eng evidence check` and `eng e2e` fail on an over-budget run dir. They never delete. `hygiene.evidence_roots` lists the roots to check.
- `eng doctor` fails a rule set to `off`. The starter config adds `evidence` and `downloads` to `gates.required`. eng-standard's CI runs all three checks on itself.
- `cargo-target-per-run` reads only the assigned value, and in `warn` mode it reports without failing `eng lint`. `eng leave-nothing` removes its own dir when nested and keeps a signal's exit code.
- Fixes found by the new check: two `t3-queue-health` tests left temp dirs, and the renovate `launch --keep` test used the parent eng's scratch root when run under eng.

## 0.11.0 (26 Oct 2026)

**Devbox project isolation, warn only.** Every devbox project runs as one Unix user, so shared defaults (Convex's `anonymous-agent` state in `~/.convex`, port 3210) let one project's tool reach another's service. This release ships the standard's five rules as an identity file, a helper and a repo check. Docs: `docs/project-isolation.md`.

- **Identity file** `.eng/project.toml`: project id, owner, port range, state path inside the checkout, and services with explicit names and argv commands. Starter: `templates/isolation/project.toml`.
- **`eng run-service` / `connect` / `stop` / `status`.** Ownership records (0600) under `$XDG_STATE_HOME/eng/owners/<project>/` hold the project, owner, checkout, PID plus `/proc/<pid>/stat` start time and boot id, and the starting agent (`ENG_AGENT_ID`, else `T3_THREAD_ID`). Every command checks the record before acting and re-checks the target after (start time, health path). Only listed commands run: `eng run-service` runs the service's `command`, and `eng connect` runs a command only when a `connect = [...]` entry equals its full argv; variable parts only as built-in `[placeholders]` types (port, a project-relative path with no `..` and no symlink component, service name; no regex). Docker/podman/compose are limited to approved subcommands, each with an allowlist of safe flags; every other flag is refused even when listed (stopping goes through `eng stop`); `exec` and `run` are never allowed. It prevents accidental cross-project actions; it is not a security boundary against a hostile agent (per-project OS users or containers are a devbox-ops follow-up). Entries cannot list launchers, inline code, kill programs or stopping docker/compose subcommands; stopping goes through `eng stop`. `stop` acts only for the starter and never signals a reused PID. Secrets come from `.eng/secrets/<svc>.env` (0600, owned, gitignored) or stdin, never argv. Inherited `CONVEX_*` is scrubbed; `HOME` is the service's own state dir.
- **`eng isolation check`** (gate `isolation`): default names and ports, unnamed compose projects, bare `convex` / `docker compose` / `kill` / `pkill` in package scripts and hooks, secret flags with values on command lines. Warn only; `isolation.mode: fail` flips it.
- **Starter and renovation pack.** `templates/eng.config.yml` gets `isolation: { mode: warn }`. Renovation audit item `project-isolation`; step 7 (`launch`) seeds the identity file and the mode.
- AGENTS.md gets an isolation rule row only in repos whose config has `isolation:`.
## Unreleased (26 Oct 2026)

**T3 queued message delivery and coordinator health.** A queued result confirms storage, not run start; coordinators now have a 30-minute on-demand queue-age check with a configurable limit.

**Self-merge runs on events and merges without a wait** (Matt, 26 Oct 2026: "No wait. Merge as soon as it's verified; post-merge checks roll back breakage.").

- `self-merge.yml` has no schedule. The 30-minute cron from PR #17 is gone. It runs when `ci` finishes, on a verdict comment or `verdict` status, when a label is added or removed, when a PR is marked ready or retargeted to main, and on dispatch. Each event looks at its own PR. Runs queue one at a time (`queue: max`, up to 100 waiting), so two merges never run at once and a newer run never replaces a waiting one.
- The hold window is gone. `ship.self_merge.hold_minutes` fails config validation with a removal message. The `hold` label still stops a PR, and the run reads every rule again just before the merge call.
- `ci.yml` job `start-self-merge` starts self-merge when a dispatched run ends, because a `GITHUB_TOKEN`-dispatched run fires no `workflow_run`. The post-merge check and auto-revert are otherwise unchanged. An auto-revert whose inverse restores a `ci.yml` without that job says in its PR body how to start self-merge by hand.

**Verifier independence is judged by identity** (approved by Matt, 26 Oct 2026). Models and providers are not part of the engineering standard. Supersedes PR #23.

- A verifier counts only when its identity (`eng verdict --by`, plus its GitHub login when `verifier_logins` is set) equals no author's identity: `Agent:` trailer ids, commit author and committer emails, and commit GitHub logins.
- risk:high (self-merge) needs PASSes on the exact head from `ship.high_risk.verifiers` (default 2) independent verifiers with distinct identities. `eng merge gate`: `merge.auto.high_risk_paths` and `merge.auto.high_risk_verifiers` (default 2) replace `second_provider_paths`, which now fails validation with a rename message. The gate's restart cause `second-provider` is now `verifiers`.
- `verifier_logins` (`ship.self_merge` and `merge.auto`) is a list of logins. Each login is one identity.
- `eng verdict` drops `--family`, `--provider` and `--model`, and fails if one is passed. Verdict records and comments carry no family or provider. Older verdict comments with those fields still parse; the fields are ignored. `Agent-Family:` trailers are no longer read.
- Renovation receipts drop the reviewer `model`, `provider` and `author_provider` fields, `--author-provider` and the cross-provider gate-file flag. `renovation.receipt.gate_paths` is no longer used.
- AGENTS.md, docs/self-merge.md, docs/merge-queue.md, the SHIPPING template, the renovation README, eng-verify and the configs describe the identity rule.

## 0.10.0 (24 Oct 2026)

**`eng merge`: the v0.10.0 merge rule as a capability for consuming repos** (Matt, 24 Oct 2026: the rule at 10:31 AM AEDT, option 2 at 11:22 AM AEDT). eng-standard itself keeps the v0.9.1 two-provider `self-merge.yml` (Option A, 3:03 PM AEDT) as its one merge path; see "Reconciled with 0.9.1" below.

- **One config, one required check.** `merge.auto` in a repo's `eng.config.yml`. The one required check is the commit status `eng-merge-gate`. The trusted `gate.yml` posts it (pull_request_target, workflow_run, issue_comment and dispatch; main's copy and main's code) after the PR's own `test` check. In queue mode, `ci.yml`'s `queued-gate` posts it on the queued commit. No job carries the name, and the gate fails a check run that does.
- **Gate hardening from the verifier rounds.** Auto-reverts are compared byte for byte, renames count both paths for the second-provider rule, raw (NUL-separated) paths mean a non-ASCII, tab or newline filename cannot slip past it, a FAIL is reported before "behind", and each verifier's latest FAIL blocks. An auto-revert that main moved past is reported behind, not rejected: watch updates it and dispatches its checks, and the updated head is checked again against main's tip.
- **Mode `strict` (default).** Branch protection requires up-to-date branches. The gate needs an independent PASS for the exact head commit, and GitHub auto-merge merges. **Mode `queue` (optional speed-up):** where the repo has a merge queue, the PASS binds the patch-id of the queued merge_group commit. `eng doctor` detects which mode the repo can run and fails a mismatch.
- **Gate rules.**
  - Gate, auth and billing paths (`merge.auto.second_provider_paths`) need PASSes from two providers other than the authors'.
  - `merge.auto.verifier_logins` binds verdicts to verifier GitHub identities. Unset, they are self-declared, and `eng doctor` says so.
  - An `auto-revert` PR passes only when all of these hold: opened by `github-actions[bot]`, on `auto-revert/<sha12>`, its target is on main, and it is the exact inverse.
- **`eng verdict ... --pr <n>`** posts the verdict comment and, in a repo with `merge.auto`, dispatches `gate.yml`.
- **`eng merge post`** (`merge-post.yml`): the shipped-artifact check after each merge. A failure opens an auto-revert PR with auto-merge on and dispatches the check with the PR number.
- **`eng merge watch`** (`merge-watch.yml`, every 10 min):
  - A red or missing check with no activity for 30 min gets the `stuck` label.
  - A FAIL restarts the owner at once. A missing verdict, or a missing second-provider PASS, restarts it 30 min after the push. A failed webhook delivery is retried.
  - In strict mode it updates a behind PR that has auto-merge on.
- **`eng merge settings`** prints the ruleset for the declared mode and never applies it.
- **Reference workflows and config** in `templates/merge-auto/` (`gate.yml`, `merge-post.yml`, `merge-watch.yml`, `ci.yml`, `eng.config.yml`), copied into a consuming repo's `.github/workflows/`. They are not live in eng-standard.
- **Reconciled with 0.9.1.** `lib/merge-queue.mjs` now takes verdict comments, the trust policy and authorship from `lib/self-merge.mjs`, so `eng merge gate` gets PR #21's fixes: only `OWNER`, `MEMBER` or `COLLABORATOR` comments count, `verifier_logins` keys each verifier, provider lookups are own-property only, an unknown or contradicting provider counts as none, and an edited comment counts from its edit. The reference config's `second_provider_paths` cover `lib/**` (everything `bin/eng.mjs` loads) and flat `auth.*`, `billing.*` and `payments.*` files as well as those directories. Tests derive each trusted workflow's `node <file>` entrypoints and require their whole import closure to need a second provider (reference workflows) or to be risk:high (eng-standard's own controller). eng-standard does not switch to `eng merge` here: that needs "Allow auto-merge" and a ruleset requiring `eng-merge-gate`, both Matt's settings, plus a follow-up PR that removes `self-merge.yml` in the same change.
- **Capped GitHub lists fail closed** (openai verifier, round 9). GitHub lists at most 3,000 files and 250 commits for a PR. `scripts/pr-gate.mjs` now classifies a PR whose file list falls short of `changed_files` as risk:high, and skips one whose commit list falls short of `commits`. `eng merge gate` reads authors from the PR's git history as well as the API.
- **Repo moved** to `Slaytek-Systems/eng-standard` (approved by Matt, 24 Oct 2026). Tags and releases survived.
- `npm test` is now `node --test test/*.test.mjs`, so it works on Node 20 and Node 24.

## 0.9.2 (24 Oct 2026)

Scratch and disk hygiene, from Warden's audit (Oct 2026): a motus proof script's mkdtemp in /tmp, Core Edge Rust targets in /tmp, equitus Deno caches per run, Docker anonymous volumes.

- **Scratch rounds.** One repo-owned scratch root, `hygiene.scratch_root` (default `${XDG_CACHE_HOME}/eng/${repo}/scratch`, never /tmp). `eng launch [--ref r] -- <cmd>` and the new `eng verdict round [--ref r] -- <cmd>` run the command in a 0700 worktree inside one round dir, and a trap removes the round on exit, failure or SIGINT/SIGTERM/SIGHUP. `eng launch --keep` is the persistent form (bare `eng launch` now asks for `--` or `--keep`). `eng gate`, `eng e2e`, `eng renovate prove`, `eng verify create` and `eng laws` use the same root; nothing eng makes lands in bare /tmp. `launch.tmp` is gone.
- **Shared caches.** `hygiene.caches` declares one Cargo target, Vite, Bun and Deno cache per repo. eng exports `CARGO_TARGET_DIR` (+ `CARGO_INCREMENTAL=0`), `ENG_VITE_CACHE_DIR`, `BUN_INSTALL_CACHE_DIR`, a stable `DENO_DIR` and `ENG_CONTAINER_LABEL` to every child.
- **Containers.** `eng clean --containers [--apply]` removes this repo's labelled containers with their volumes, and its labelled volumes.
- **Evidence per PR.** e2e evidence goes to `<evidence_dir>/pr-<n>/<sha>/`. `eng clean --evidence [--apply]` deletes merged or closed PRs' dirs and reports the rest.
- **Built-in disk rules in `eng lint`** (`hygiene.disk_lint`, on by default; each bites its fixture): `script-bare-tmpdir`, `cargo-target-tmp`, `deno-dir-unstable`, `container-no-rm`, `volume-prune-all` (bans `docker volume prune -a`), `credential-to-disk`. Upgrading repos may see new findings: fix them or baseline them (`eng renovate baseline --kind lint`).
- **`eng doctor`** (gate `doctor`) fails a config that skips the scratch root, the cache for each toolchain the repo uses, the Vite `cacheDir` (each package that declares Vite needs its own `vite.config` in its directory: Vite reads no cache env var), the container label, `hygiene.evidence: per_pr` or the disk rules, and lists disk-rule findings.
- SHIPPING.md §5 and the AGENTS.md block describe the rules. The test suite keeps eng's scratch and caches inside each run (`XDG_CACHE_HOME`).

## 0.9.1 (24 Oct 2026)

- **Two-provider self-merge** (Option A, approved by Matt, 24 Oct 2026, 3:03 PM AEDT) for eng-standard's own `self-merge.yml`:
  - risk:low merges after one independent PASS on the exact head. risk:high (including auth and billing paths, now in `ship.high_risk.paths`) merges after PASSes from two verifiers on two different providers, neither the authors'. Before this, risk:high waited for Matt.
  - The head must contain main's tip. A missing, stale or FAIL verdict refuses; each verifier's latest verdict counts and any FAIL blocks. Hold, draft and the hold window are kept; the window also counts from the latest counted verdict.
  - A red post-merge `test` on main opens the tip's exact inverse as an `auto-revert/<sha12>` PR from `github-actions[bot]`. It is the only PR that may merge while main is red, and it still needs verdicts. The workflow gains `pull-requests: write`.
  - `eng verdict ... --pr <n>` also posts an `eng-verdict/v1` PR comment (head SHA, family, provider); self-merge reads verdicts from those. Comment format, `parseVerdicts` and `authorsFrom` come from PR #20.
  - `FAMILY_PROVIDER` moves to `lib/self-merge.mjs` (a risk:high path); `lib/renovate.mjs` re-exports it.
  - Trust policy: only verdict comments from `OWNER`, `MEMBER` or `COLLABORATOR` count, filtered before any verdict counts or supersedes another. Optional `ship.self_merge.verifier_logins` (login to provider) limits them to listed logins with the login's provider. An unknown provider counts as none.
  - `glob2re` uses dotAll (from PR #20), so a newline in a file's name or a rename's old name still matches risk:high patterns.

## 0.9.0 (23 Oct 2026)

- **Renovation pack** (spec v1, approved by Matt, 23 Oct 2026): `eng renovate` brings an existing repo up to the standard through normal PRs. It never merges, never edits rulesets or protection and never touches prod. Lead guide: `renovation/README.md`.
  - `audit` (read-only; writes only `renovation/audit.json` and `audit.md`), `plan`, and `apply <step>` for seven fixed steps: docs-config, baselines, gates-warn, gates-enforce, verifier, e2e, launch. `apply` refuses the default branch and out-of-order steps, and records `renovation.completed_steps`.
  - Baselines: `renovation/baselines/{secret-filename,lint}.json` (fingerprint, path, reason, owner). `eng renovate scan` and `eng lint` fail only on new findings; baseline edits print every entry and the CODEOWNERS owner; a shrinking baseline is reported as progress.
  - `render [--check]`: SHIPPING.md from the template with repo values, local rules kept between `renovation:local` markers, divergences in `renovation/divergences.md`.
  - `wire --ci buildkite|github` writes a CI snippet and prints the ruleset change for an admin. `ci-preflight` compares Bun/Node pins with the CI image and exits 3 with `needs-decision: ci-image-operator`.
  - `refresh` applies `renovation.merge_policy` (strict or not, verdict carry by patch-id). `receipt` drafts a `core-edge.ship-receipt/v1` review comment (adapter 1) from the latest independent verdict and flags gate-file changes that need a cross-provider reviewer. It never posts.
  - `prove`: per-gate proof ledger `renovation/proof/<sha>.json` with timeouts; timeout or admission is blocked, never pass; resumable.
- `eng launch` / `eng launch down <dir>`: a private 0700 worktree and tmp under `$TMPDIR`; never chmods an existing checkout. Template `launch:` gains `worktree`, `tmp`, `mode`, `base`.
- `eng verdict` records `--provider` (openai, anthropic, google, xai), `--model`, `--session`, `--route`, plus the base tip and head tree. `--base <ref>` / `ENG_BASE` sets the base for stacked PRs.
- Fixes: `eng verify create` and `eng laws` use `os.tmpdir()` instead of a hard-coded `/tmp` (TMPDIR is honoured). The rendered Buildkite pipeline lints against `origin/<project.default_branch>`, not `origin/main`.
- Proof on eng-sandbox only: `docs/evidence/2026-10-23-renovation-pack-sandbox.md`.

## 0.8.3 (20 Oct 2026)

- Fixed rule 20, **Callback contract**, in SHIPPING.md §0 and AGENTS.md (approved by Matt, 19 Oct 2026).
  - Scripts, CI jobs and T3 threads that wake a bot post only when work is done, blocked or needs a decision. No progress pings, no all-clears.
  - The post is one line: `<status> <thread-id> <one short clause>`, status `done`, `blocked` or `needs-decision`. Detail goes in a Core note or file, named by its id.
  - A woken bot reads only that payload and at most the last 2 messages of the named thread. If nothing needs a decision or reply, it exits without a message.
- Fixed rule 21, **Hand off by default**, in SHIPPING.md §0 and AGENTS.md (approved by Matt, 19 Oct 2026).
  - Any coding or bulk job over about 20 steps goes to a T3 thread (builder plus independent verifier). The lead hands it off, ends its run and wakes on the rule-20 `done` or `blocked` callback.
  - Leads check progress with cheap live-state checks (verdict status, CI, `gh pr checks`, `gh pr view`), not by reading whole threads or diffs.
  - Decisions for Matt and client-facing communication stay with the lead.
  - Rollout: tested first on Eng Manager's Fleet Control Tower webhook from 19 Oct; project leads switch on Wed 21 Oct 2026.
- `test/cli.test.mjs` checks rules 20 and 21 in the rendered SHIPPING.md and AGENTS.md.
- Docs and rendered text only; no CLI behaviour change.

## 0.8.2 (19 Oct 2026)

- Fixed rule 19, **Briefs live in Core**, in SHIPPING.md §0 and AGENTS.md (approved by Matt, 19 Oct 2026). Verdicts and audits must be able to see exactly what a builder was told, even after the devbox restarts or `/tmp` is cleaned.
  - A brief one agent hands another (builder, reviewer or verifier thread) is written first as a note in the repo's Core space tagged `brief`; the worker's prompt names the Core note id and may paste the brief inline too.
  - `/tmp` or any other scratch path is never the only copy; a local file is only a convenience copy of the Core note.
  - A revision updates the same note (Core keeps revision history); no second note for r2.
- `test/cli.test.mjs` checks rule 19 in the rendered SHIPPING.md and AGENTS.md.
- Docs and rendered text only; no CLI behaviour change.

## 0.8.1 (19 Oct 2026)

- Fixed rule 18, **Clean up on merge or close**, in SHIPPING.md §0 and AGENTS.md, with details in SHIPPING.md §5 (approved by Matt, 17 Oct 2026). A devbox forensics pass found about 100 GB of agent leftovers.
  - Delete a PR's task and review worktrees when it merges or closes; reuse one worktree per PR across review rounds.
  - Evidence keeps only logs, diffs, verdicts and screenshots (never repo copies, `node_modules`, binaries or databases) and is deleted on merge or close.
  - No `node_modules` installs in review-only worktrees; use a shared pnpm or bun store with hard links.
  - One shared build cache per toolchain (Rust: `CARGO_TARGET_DIR` or `sccache`, `CARGO_INCREMENTAL=0` for agents), not one per lane or worktree.
  - Walkthrough videos and media go off the box (Drive or similar).
  - Temp dirs delete themselves.
- `templates/eng.config.yml`: `hygiene` comment points to rule 18.
- Docs and rendered text only; no CLI behaviour change.

## 0.8.0 (19 Oct 2026)

- **eng-standard merges its own low-risk PRs** (Design A, approved by Matt, 19 Oct 2026, 3:55 PM AEDT). Rule in `AGENTS.md`, details in `docs/self-merge.md`.
  - Root `eng.config.yml` for eng-standard itself: merge rule, `ship.high_risk.paths` (workflows/CI, merge setup, `bin/`, `scripts/`, package scripts and deps, vendored code) and `ship.self_merge` (hold window 120 min, `hold` label, `test` check, `verdict` status).
  - `.github/workflows/risk-label.yml`: labels each PR into main `risk:high` or `risk:low` from its changed paths; a version-only `package.json` / lock bump stays low. Runs main's code only.
  - `.github/workflows/self-merge.yml` (every 30 min + dispatch): squash-merges at most one `risk:low` PR per run with the head SHA pinned, when `test` and `verdict` are green on that SHA for the hold window and there is no `hold` label; never onto a red main. Then deletes the branch and dispatches `ci.yml` on main.
  - `ci.yml` gains `workflow_dispatch` (a GITHUB_TOKEN merge fires no push event).
- New: `eng verdict status --pr <n>`, and `--pr <n>` on `eng verdict PASS|PASS+NOTES|FAIL`: posts commit status `verdict` (success/failure from `eng verdict check`) on the PR's exact head SHA.
- `lib/risk.mjs`, `lib/self-merge.mjs`, `scripts/pr-gate.mjs`; `test/self-merge.test.mjs` covers risk paths, the merge decision and the status post.
- Undo: `gh pr revert <n>`.
