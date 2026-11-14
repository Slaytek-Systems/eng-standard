# @slayteksystems/eng-standard v0 (sandbox only)

One file, `eng.config.yml`, drives everything. Agent-agnostic: plain SKILL.md files in `.agents/skills` (eng never writes into `.claude/skills`; one `ln -s ../.agents/skills .claude/skills` makes them visible to Claude Code, and `eng doctor` says which tools can see them), AGENTS.md (Codex/Cursor) + CLAUDE.md (`@AGENTS.md`), git hooks, and a Node CLI.

## Start here

How to pin, set up, keep current, upgrade and uninstall the standard, with the checks for each: [docs/lifecycle.md](docs/lifecycle.md). Every rendered `SHIPPING.md` carries the short version (Reference, section "This standard"). The `AGENTS.md` block is three lines: take the route a blocking hook or check names (or find the rule in `SHIPPING.md` when it names none) and never bypass one, where the skills are, and that `SHIPPING.md` has the rest.

## Profiles

eng-standard is public, so what it renders by default names no person, company, private tool or private note. That
default is `profile: generic`, and `eng init` writes it into a new `eng.config.yml`.

- **Roles, not people.** Where a rule needs someone to approve (stack choices, `risk:high` PRs, new rules, Bend laws),
  it names the repo owner. Set `project.owner` (a name, `@handle` or role) and every rendered file uses it. Unset, the
  text says "the repo owner".
- **Reasons, not dates.** A rule states why it exists ("a re-run until green hides real failures") instead of who
  approved it when. Incident evidence stays as a short anonymised reason.
- **Recommendations.** `STACK.md` lists each pick with its reason for the owner to adopt or replace. A decision is
  `DRAFT` (not decided yet), `APPROVED` (adopted) or `IN USE` (already in place), the same values as before.
- **No private defaults.** No model routing note (`models.routing` is optional), no machine path for `e2e.node_bin`
  (node on `PATH`), cron comments in UTC, and the starter's sample rules (`saveOrder`, the cart laws) are commented
  examples.
- **Persist markers.** A permanent dev server is marked with `eng.persist=true` (container label) or `ENG_PERSIST=true`
  (environment) by default. `slaytek.persist=true` and `SLAYTEK_PERSIST=true` always count too, in every profile.

`profile: slaytek` is Slaytek Systems' own profile. One line restores exactly what eng rendered up to v0.17.2: Matt as
the approver, the dated attributions and incident names, the persist names above as defaults, the Core routing note,
and three rules only Slaytek runs (briefs live in Core, the T3 callback contract, hand off by default). For each fixture
in `test/fixtures/profile/`, that output is byte-identical to v0.17.2 except one reviewed line from 0.18.2: the
pipeline's lint step is `npx eng lint`, without `--config-from origin/main`, and from 0.23.1 the pre-commit hook and
the pipeline run the installed eng instead of npx (`test/profile.test.mjs`).

A config with no `profile` line still validates and renders the generic text. `eng sync` and `eng doctor` print one
line saying the Slaytek rules are now opt-in, with the line to add. eng never adds it itself, because a config may
belong to someone outside Slaytek.

## One standard, one contextual init

There is one standard and one init (Matt, 6 Nov 2026; Core nd71bs9kx7rnwphcj0jhp50b1n8hpk4d). `eng init` looks at the repo in front of it and applies the same bar. A new repo gets the checks from the start. A repo that already ships gets baselines for what it has today, so only new findings fail (`renovation/README.md`).

When you send a message with T3 `t3_thread_send`, a `queued` result means T3 stored the message. It does not confirm delivery or a new run. Check `t3_thread_read` activity or `t3_thread_wait` for a new run. For time-critical or approved sends, use `mode: "auto"` and confirm that a run started.

Run the coordinator queue-age check from an eng-standard checkout with `node lib/t3-queue-health.mjs snapshot.json`. The default age limit is 30 minutes. Set another limit with `--minutes N`. The command exits 1 when it finds an old item and 2 when the input is invalid. See `renovation/README.md` for the snapshot format.

The CLI is the hallway (Matt, 6 Nov 2026; Core nd756dc09wh4rt0d3bk74g5gv18hqpfe): fit checks, verification tooling on the exact commit, stacked verifiers, the merge gate and the post-merge check. `eng --help` lists it.

| Command | Does |
|---|---|
| `eng init [--owner @handle]` | one contextual init: seed `eng.config.yml` if missing, render everything, set `core.hooksPath .githooks`, print the branch ruleset advice. A repo that already ships also gets a CODEOWNERS line and baselines |
| `eng sync [--check]` | render AGENTS.md, SHIPPING.md, hooks and skills from the config; `--check` fails if any generated file or lock differs, if `.eng/lock.json` was rendered by another eng version or names none, or if the package.json pin floats |
| `eng lint` | fast fit: built-in and repo regex rules and credential-looking filenames; baselined findings pass |
| `eng run [--by <id>] [--ref r] [--budget b] -- <cmd>` | run a command in a private 0700 worktree of the exact commit (HEAD unless `--ref`), under `hygiene.scratch_root`, removed on exit, under the default budget (memory 2048 MB, 2 workers, 1800s) or `--budget "memory=4G workers=2 timeout=10m"`; a command its budget stops fails, naming the budget. With `--by` the command, exit code, output tail and SHA are that verifier's evidence. `--keep` / `down <dir>` is the persistent form |
| `eng run <name>` / `eng run --here -- <cmd>` | a declared run (`project.commands.<name>`, or `launch`) or one command, in this checkout, that must leave nothing behind: no container, network, volume, temp entry or process (`hygiene.run_rules.ephemeral_runs`). `eng gate` runs each declared run this way |
| `eng verdict PASS\|PASS+NOTES\|FAIL --by <id> [--review] [--pr <n>]` | record the verdict for HEAD with that verifier's runs; a PASS needs at least one and all must pass. `--review` counts only for `verification.review_only_paths`. `--pr` posts it as a PR comment and the `verdict` status |
| `eng verdict check [--pr <n>]` / `eng verdict status --pr <n>` | a counted PASS for this exact commit, and on a risk:high change (`ship.high_risk.paths`) counted PASSes from `ship.high_risk.verifiers` distinct verifiers (a verdict for another SHA is reported, never counted; each verifier's latest verdict counts and any FAIL blocks), after the evidence-dir disk rules pass. With `--pr` (and always in `status`) it also counts the PR's trusted verdict comments for that head, so verifiers in separate clones count together; without it, only this clone's records count |
| `eng e2e [--if-required]` / `--required` / `--flake-check` | the e2e verifier (tester-army/e2e) with evidence per PR and SHA. `--required` prints whether this diff needs it (`--exit-code` = 10 when not). `--flake-check` classifies repeated runs |
| `eng rules prove` | each lint rule fails on its recorded fixture; with `laws.enabled`, the Bend proofs check, each planted mutation breaks them, and the parity test passes |
| `eng gate [--heavy] [--event pr\|main [--base <ref>]] [<step>...]` | every script in `verification.checks_dir` first, each under its budget (the wall: a failing, flaky, stale or over-budget check fails the gate, whatever the verdict says), then every `gates.required`; skipped or missing = failed. Heavy checks run in CI or with `--heavy`; a gate that deferred one exits 3 (incomplete), never 0. `eng gate checks` runs only the checks; CI runs it on its own identity. `--event pr` runs each check `verification.flake_runs_pr` times and, with `verification.pr_checks: affected`, only the checks whose `# covers:` paths the change touched; main runs them all `flake_runs` times. `verification.parallel: <n>` runs up to n at once; `# serial: <why>` runs a check alone |
| `eng merge gate\|post` | `merge.auto`: the one required check requires the tooling's PASS for the exact head (`docs/merge-queue.md`). `post` runs the post-merge check on main, opens the exact-inverse revert on red, and tends open PRs |
| `eng doctor [--launch]` | is this repo on the hallway: config pieces, an enforcer for each `agents.rules` entry, merge settings (and the ruleset to apply), disk rules, a stale lock or floating pin. It reports how many of eng's skills Codex, Cursor and Claude Code each see, and whether each one runs eng's guard, with the link or entry that would fix it; eng never creates or changes links. It prints the installed, rendered and latest eng-standard versions and the CHANGELOG entries in between (latest from GitHub `main` or `ENG_STANDARD_SOURCE`). `--launch` proves the `launch:` contract with two concurrent runs |
| `ship.log_step`, `hooks.pre_commit`, `hooks.pre_push`, `agents.post_edit_command`, `models.routing`, `models.pstack`, `stack.defaults.agent_activity_ui` | optional config: the SHIPPING.md logging step, extra pre-commit commands (after `sync --check` and `lint`), extra pre-push commands (after eng's push checks, each with the hook's arguments and the same ref lines on stdin; `docs/lifecycle.md`, Git hooks), a Claude Code PostToolUse hook, the model routing note, pstack role models, and the STACK.md default for agent activity UI (shadcn Trace) |
| `guard` | `on` (default) or `off`. On: before a command runs, `.eng/guard` blocks rewriting pushed history, skipping checks, throwing away local work and editing the guard, and names the allowed route. Claude Code runs it from `.claude/settings.json`; `eng doctor` prints the link or entry that wires Codex and Cursor (`docs/lifecycle.md`, Guard) |
| `profile`, `project.owner` | `generic` (default) or `slaytek`, and who approves for this repo (README, Profiles) |
| `npm test` | this package's own tests (`node --test`) |

Dropped in the 0.14.0 cut: `renovate` (into `init`, `lint` and `sync --check`), `launch`, `ephemeral`, `leave-nothing` and `verdict round` (into `run`), `launch-check` and `merge settings` (into `doctor`), `drift-check` (`sync --check`), `e2e-required` (`e2e --required`), `evidence check` (into `verdict check`), `laws` (into `rules prove`), `merge watch` (into `merge post`), `verify create`/`maintain` (the `eng-verify` skill with `run --by`). Gone from the global CLI: `isolation`, `run-service`, `connect`, `stop`, `status`, `stack-check`, `stack-audit`, `fallow`, `conform`, `ci-verdict`, `fetch`, `downloads check`, `find-laws`, `laws --write`, `laws approve`, `mistake`, `retro`, `ship next`, `clean`. A repo's own tool runs as a `project.commands` entry named in `gates.required`.

Vendored upstream skills (verbatim, path-rewritten `.cursor/skills/` → `.agents/skills/`): see `vendor/PINS.txt`. Licenses: MIT (vendor/*/LICENSE).
