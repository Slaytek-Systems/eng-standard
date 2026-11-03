# The standard's lifecycle: pin, upgrade, use, onboard, renovate, remove

This is the one guide to living with eng-standard in a repo. Every rendered `AGENTS.md` links here (section "This
standard"), and the package ships this file, so an agent finds it at `node_modules/@slayteksystems/eng-standard/docs/lifecycle.md`
or at https://github.com/Slaytek-Systems/eng-standard/blob/main/docs/lifecycle.md. The map of every entry point and
what each one covers is [standard-map.md](standard-map.md).

## Where things live

| You need | Read |
|---|---|
| The rules for this repo, day to day | the rendered `AGENTS.md` block, then `SHIPPING.md` (the shipping SOP), then `STACK.md` |
| A skill | `.agents/skills/<name>/SKILL.md` (Claude Code also sees them under `.claude/skills/`) |
| Every `eng` command | `eng commands`, then the [README](../README.md) table |
| What changed between versions | [CHANGELOG.md](../CHANGELOG.md) (also shipped in the package) |
| Every setting | `eng.config.yml`; the starter with a comment on each key is `templates/eng.config.yml` |
| Bringing an old repo up to the standard | [renovation/README.md](../renovation/README.md) |

## Pin

A repo installs the standard as a dev dependency pinned to a release tag. The package is not on npm; it installs
from GitHub:

```json
"devDependencies": {
  "@slayteksystems/eng-standard": "github:Slaytek-Systems/eng-standard#vX.Y.Z"
}
```

- Pin a `vX.Y.Z` tag. CI tags every release: `.github/workflows/release-tag.yml` creates `vX.Y.Z` on the main commit
  that changed `package.json` to X.Y.Z, once that commit's `ci` run on main is green. A tag is never moved or deleted
  (the workflow refuses, and the rendered pre-push hook blocks it). The latest tag is
  `gh api repos/Slaytek-Systems/eng-standard/tags -q '.[0].name'`.
- Releases from 0.9.1 to 0.13.x have no tag (tagging started with 0.14.0, and earlier releases were not tagged by
  hand). A repo on one of those pins its full commit SHA until it upgrades.
- A full commit SHA is also immutable. A branch (`#main`), a short SHA, a range or no `#` at all is floating: the
  standard would change under the repo with no commit in it. `eng drift-check` fails a floating pin.
- Pins that still say `Mattslayga/eng-standard` work through GitHub's redirect. Move them to `Slaytek-Systems` on the
  next upgrade; `eng upgrade-check` notes it.
- Run the CLI as `npx --no-install eng`, `bunx eng` or `node node_modules/@slayteksystems/eng-standard/bin/eng.mjs`.
  The pre-commit hook reads `$ENG` for the same choice.

## Versions and the CHANGELOG

- Every change to eng-standard that changes behaviour bumps `package.json` and adds a CHANGELOG entry in the same PR.
  Minor means a new command, config area or policy. Patch means a rule or doc added to an existing area.
- `npm test` in eng-standard fails when `package.json`, `package-lock.json` and the newest versioned CHANGELOG entry
  disagree (`test/docs.test.mjs`).
- `eng sync` records the version that rendered a repo's files as `package` in `.eng/lock.json`.

## Upgrade

1. `eng upgrade-check`. It prints the installed version, the version in `.eng/lock.json`, the latest version on
   eng-standard `main` and the CHANGELOG entries in between. Exit 1 means behind, stale or a floating pin; 2 means it
   could not read the latest (unknown is not current); `--warn` reports and exits 0; `--source <checkout>` reads a local
   eng-standard checkout instead of GitHub.
2. Read every entry it lists. Entries marked risk:high or "needs Matt" change merge gates, CI or permissions.
3. Branch, move the pin to the new `vX.Y.Z` tag, install with the repo's package manager.
4. `eng sync`, then review the diff. Only generated files and `.eng/lock.json` should change.
5. `eng drift-check` and `eng gate`. A renovated repo also runs `eng renovate audit`: it reports `renovation.version`
   behind the pack, and `eng renovate plan` shows any new step.
6. One PR, titled `eng-standard X.Y.Z`. It goes through the repo's own gates and an independent verifier like any PR.

## Drift detection

| Check | Fails when | Where it runs |
|---|---|---|
| `eng drift-check` | a generated file, symlink or lock path differs from what `eng.config.yml` renders; the lock was rendered by another eng version; the pin floats | `.githooks/pre-commit`, gate `drift`, the rendered CI pipeline |
| `eng upgrade-check` | the installed version is behind eng-standard `main`, the lock is stale, or the pin floats | on demand, and before every upgrade PR. It reads the network, so it is not a gate |
| `eng renovate render --check` | `SHIPPING.md` or `renovation/divergences.md` differ from their render | renovated repos' CI (`renovation/wire/<ci>.yml`) |
| `eng renovate audit` | (reports) `renovation.version` is behind the pack | on demand |
| `eng stack-audit` | declared dependencies are below the Modern Stack floors | monthly, and on demand ([modern-stack.md](modern-stack.md)) |
| `eng doctor` | the config skips a disk rule, the scratch root or the merge mode the repo can run | gate `doctor` where listed |

## Day to day

The rendered `AGENTS.md` block is the day-to-day guide. In short: start non-trivial work with `poteto-mode`, run
`eng gate` before you ask for review, never merge your own PR, and get a verdict from a verifier whose identity differs
from every author's (`eng verdict round -- <cmd>`, then `eng verdict PASS --by <id> --pr <n>`). Never rewrite pushed
history: after a push every fix is a new commit and main comes in by merge (`gh pr update-branch <n>`); the rendered
pre-push hook refuses a non-fast-forward push on any branch (SHIPPING.md rule 1). `SHIPPING.md` is the shipping SOP and
wins over any other doc in the repo.

## New repo: the starter pack

1. Add the pinned dependency (above) and install.
2. `eng init`. It copies the minimal starter `templates/starter/eng.config.yml` when the repo has none, renders every
   generated file (AGENTS.md block, SHIPPING.md, STACK.md, CLAUDE.md, skills, hooks, CI pipeline, PR template), sets
   `core.hooksPath .githooks`, and prints the branch ruleset to apply by hand. eng never edits rulesets.
3. Edit `project.name` and `merge` (who merges and how), then `eng sync`, commit, open the PR. `eng gate` passes on
   day one with the stage 1 gates (`test/starter.test.mjs` proves it on an empty repo).
4. Turn on the later gates one stage per PR (next section). Matt approves `eng.config.yml` changes.

## Turning on gates in stages

The starter requires only what a brand-new repo can pass. Each later stage is one PR: copy the named sections from the
full reference `templates/eng.config.yml` (every key commented), run the stage's own command until it passes, then add
its gate ids to `gates.required`. A gate in the list must pass, and a skipped gate counts as failed, so never add a gate
before its command passes.

| Stage | Gates added | Copy from the full reference | Prove it first | Turn it on when |
|---|---|---|---|---|
| 1, day one | `drift`, `stack`, `lint`, `rules`, `verdict` | nothing (the starter) | `eng gate` | always |
| 2, tests | `test`, `typecheck` | `project.commands` (`vp test run`, `vp check`); `constraints` for repo lint rules | `eng gate` with them listed | the repo has code and a test |
| 3, disk | `doctor`, `evidence`, `downloads` | `hygiene` (scratch root, caches, disk rules, run rules) | `eng doctor`, `eng evidence check`, `eng downloads check` | before the first long test, e2e or container run |
| 4, run it | `launch`, `isolation`, `verify` | `launch`, `isolation`, `audits`; `.eng/checks/<id>.sh` with `eng verify create <id>` | `eng launch-check`, `eng isolation check`, `eng verify maintain` | the app starts locally; then `create-verification-skill` writes `verify-<app>` |
| 5, e2e | `e2e`, `fallow` | `e2e` (pins, policy), `fallow`; `templates/e2e/` | `eng e2e --flake-check`, `eng fallow` | there is a user journey; the repo is JS/TS |
| 6, formal | `laws`, `conform` | `laws`, `flags`, `db`; `formal` is already set | `eng laws`, `eng conform` | pure logic worth proving (money, permissions, state machines) |

`verdict` passes on `main` and on a branch with no change. On a PR it needs an independent verdict: that is the merge
gate working, not a setup gap. `test/starter.test.mjs` fails when a gate the full reference can require has no stage
in this table or in the starter's header.

## New agent in a repo

1. Read the rendered `AGENTS.md` block in full, then `SHIPPING.md`. Claude Code gets the same text through
   `CLAUDE.md` (`@AGENTS.md`); Codex reads `AGENTS.md` directly.
2. Model choices come from the Core routing note the block names, not from skill defaults.
3. Put an `Agent:` trailer on every commit, so the verdict gate can tell author from verifier.
4. Use a skill by reading `.agents/skills/<name>/SKILL.md`; most are manual-only and will not load on their own.

## Brownfield: the renovation pack

An existing repo adopts the standard in seven fixed steps, one small PR each: `eng renovate audit` (read-only), then
`eng renovate plan`, then `eng renovate apply <step>` on a branch for each step. Pre-existing findings go into reviewed
baselines; gates start in warn mode and move to enforce. Full steps, commands and config: [renovation/README.md](../renovation/README.md).

## Exceptions and waivers

There is no general waiver. Each kind of exception has one recorded place, an owner and a check that reads it.

| Exception | Where it is recorded | Who approves | What reads it |
|---|---|---|---|
| Off-stack language, framework or package manager | `stack.exceptions: [{kind, name, reason, approved_by}]` | Matt | `eng stack-check`; listed in STACK.md |
| A repo below a Modern Stack floor | `standard/modern-stack.yml` `exceptions` (in eng-standard) | Matt | `eng stack-audit` |
| A local rule that differs from the standard | `renovation.divergences` and `renovation/divergences.md` | repo lead, Matt for merge rules | `eng renovate render --check` |
| Pre-existing findings | `renovation/baselines/*.json`, `fallow-baselines/` (CODEOWNERS-owned) | the baseline owner | `eng renovate scan`, `eng fallow` |
| A lint rule that must not apply to some paths | `constraints.rules[].exclude` | PR review | `eng lint` |
| A rule no check can enforce | `agents.rules` with `enforced_by: review` and a `why` | PR review | `eng verify maintain` fails without the why |
| A flaky e2e test | quarantine: report-only plus an issue | repo lead | `eng e2e --flake-check` |
| Isolation not enforced yet | `isolation.mode: warn` | repo lead | `eng isolation check` |

## Remove the standard

`eng uninstall` is a dry run. `eng uninstall --apply` deletes every file and symlink `eng sync` manages, deletes
`.eng/lock.json`, strips the eng block from `AGENTS.md` (your text stays) and unsets `core.hooksPath`. It keeps any
generated file you edited by hand and says so. You remove the package.json dependency, CI steps that call `eng` and the
ruleset's required checks yourself. `eng.config.yml`, `.eng/checks`, evidence and baselines are yours.

## Report a problem with the standard

A wrong rule, a command that fails for a reason the standard caused, or a doc that disagrees with the code: open an issue
at https://github.com/Slaytek-Systems/eng-standard/issues with the repo, the output of `eng upgrade-check` and the failing
command's output. Fix it upstream in eng-standard, never by editing generated files in the repo (`eng drift-check`
fails). An incident or revert in eng-standard itself leaves a guard, logged in [guards/LOG.md](../guards/LOG.md).

## How eng-standard checks its own docs

`npm test` (the `test` check on every PR) runs `test/docs.test.mjs`. It fails when:

- `package.json`, `package-lock.json` and the newest CHANGELOG version disagree;
- the README command table misses a command that `eng commands` prints;
- a doc, skill or rendered file names an `eng <command>` that does not exist;
- a relative link in this repo's docs points at a missing file;
- a doc the rendered AGENTS.md points at is not shipped in the package;
- a doc or script still names the old repo owner.

`test/no-force-push.test.mjs` fails when any doc, template or rendered file (vendored skills included) tells an agent to
force-push, and proves the rendered pre-push hook and deny list refuse it. Vendored pstack sentences that said so are
replaced at install time through `vendor/pstack/REWRITES.tsv`. `test/starter.test.mjs` runs `eng init` and `eng gate`
on an empty repo, and fails when a gate has no stage in the guide. `test/release.test.mjs` covers the release-tag rule
and the `release-tag` job in `ci.yml`.

`test/standard.test.mjs` proves the rendered "This standard" section, the drift-check pin and lock-version checks,
`eng upgrade-check` and `eng uninstall` in a scratch repo.
