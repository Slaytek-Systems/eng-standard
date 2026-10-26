# Renovation pack (eng-standard 0.9.0)

The renovation pack brings an existing repo up to the standard. The repo lead applies it through normal PRs. The pack never merges, never bypasses protection, never edits rulesets and never touches prod. It writes files on a branch; the lead reviews, commits and opens the PR, and that PR goes through the repo's own gates and verifier.

Spec: renovation pack v1 (approved by Matt, 23 Oct 2026). Code: `lib/renovate.mjs` (rules, pure) and `lib/renovate-cli.mjs` (IO).

## How a lead applies it

```sh
npx eng-standard@0.9.0 renovate audit      # read-only; writes renovation/audit.json and renovation/audit.md
npx eng renovate plan                      # the ordered PR list and the next step
git switch -c renovate/docs-config
npx eng renovate apply docs-config --owner @policy-owner
git diff                                   # review, commit, open a normal PR
```

Repeat `plan` → branch → `apply <step>` → PR for each step. A step runs only after the steps before it are in `renovation.completed_steps`, and never on the default or a protected branch.

## Steps (fixed order, one small PR each)

| # | Step | What `apply` writes |
|---|---|---|
| 1 | `docs-config` | `eng.config.yml` (seeded from `templates/eng.config.yml` if missing) with a `renovation:` block, `SHIPPING.md` rendered with the repo values, `renovation/divergences.md`, a CODEOWNERS line for `renovation/baselines/` |
| 2 | `baselines` | `renovation/baselines/secret-filename.json` and `lint.json`; fallow baselines through `eng fallow --save-baseline` when fallow is installed (otherwise it says blocked) |
| 3 | `gates-warn` | `renovation.gates.mode: warn` and `renovation/wire/<ci>.yml`; prints the ruleset change for an admin |
| 4 | `gates-enforce` | `renovation.gates.mode: enforce`: new findings fail, baselined ones pass |
| 5 | `verifier` | `ship.verifier`, `renovation.receipt.adapter`, `.gitignore` entry for `renovation/receipts/` |
| 6 | `e2e` | `renovation.proof.gates` (name, command, timeout) from `project.commands` |
| 7 | `launch` | `launch: { worktree: private, tmp: $TMPDIR, mode: "0700", base: <default branch> }` |

## Commands

| Command | Does | Exit |
|---|---|---|
| `eng renovate audit [--json]` | Present, partial or missing for each item, with evidence and the suggested step. Items: eng.config.yml, SHIPPING.md, merge policy, pack version, baselines, secret scan, fallow, CI checks, toolchain vs CI image, gate mode, verifier/receipt, e2e and proof, launch contract, checkout and tmp modes. Writes only under `renovation/` | 0 |
| `eng renovate plan` | The seven steps with done, next or todo and the open audit items | 0 |
| `eng renovate apply <step>` | Writes that step's files on the current branch and records the step | 0, or 1 when out of order or on the default branch |
| `eng renovate render [--check]` | Renders `SHIPPING.md` and `renovation/divergences.md`. `--check` fails when either differs. Text between `<!-- renovation:local -->` and `<!-- renovation:local:end -->` is kept; a pre-existing SHIPPING.md the standard did not write goes there whole on the first render | 1 on drift |
| `eng renovate baseline [--kind secret-filename\|lint\|all] [--reason r] [--owner o]` | Saves a baseline. Prints every added and removed entry and the CODEOWNERS owner who must review the edit. New entries need `--reason` | 0 |
| `eng renovate scan` | Compares secret filenames and eng lint findings with the baselines. Prints a notice when a baseline changed on this branch. Fails on new findings, or on baselines with no CODEOWNERS owner. Warn mode reports only | 1 on new findings in enforce mode |
| `eng renovate wire --ci buildkite\|github` | Writes `renovation/wire/<ci>.yml` (preflight, scan, lint, render check, fallow) and prints the ruleset change for an admin. It never applies it | 0 |
| `eng renovate ci-preflight` | Compares the repo's Bun and Node pins (`packageManager`, `.bun-version`, `.node-version`, `.nvmrc`, `.tool-versions`) with `renovation.ci.toolchain` for the named image and queue. A mismatch is `needs-decision: ci-image-operator` with the image and queue named. The pack does not build images | 3 on needs-decision |
| `eng renovate refresh` | Applies the merge policy: strict and behind → update the branch (merge, no force push), then refresh again. Otherwise it reports whether the verdict carries by patch-id, needs a fresh verifier, or needs a new receipt draft | 3 when a refresh or re-verify is needed |
| `eng renovate receipt --pr <n> --author-session <id>` | Drafts the repo's receipt from the latest independent verdict for this patch-id into `renovation/receipts/<head>.md`. Flags gate-file changes that need a cross-provider reviewer or a human approval. Never posts | 0 |
| `eng renovate prove [--gate g]... [--timeout s] [--force]` | Runs each proof gate with a timeout and records pass, fail or blocked (timeout or admission) in `renovation/proof/<sha>.json` after every gate. A re-run resumes and skips passed gates. Anything but all-pass is NOT PROVED | 0 proved, 1 failed, 3 blocked |
| `eng launch [--ref r] -- <cmd>` / `eng launch --keep` / `eng launch down <dir>` | Makes a private 0700 round dir under `hygiene.scratch_root` (never /tmp) with a 0700 worktree and a 0700 tmp. It never chmods an existing checkout. `-- <cmd>` runs the command there and removes the round on exit, pass or fail (v0.9.2). `--keep` keeps it; `down` removes it without `--force` | the command's exit code |

## Config

```yaml
renovation:
  version: 0.9.0                   # pack version last applied; audit reports drift against a newer pack
  completed_steps: [docs-config]   # apply appends; order is fixed
  policy_owner: "@lead"            # owns renovation/baselines/ in CODEOWNERS
  merge_policy: { strict: false, verdict_carry: patch-id }   # strict: true is a divergence, recorded in divergences.md
  divergences: []                  # [{ rule, standard, local, reason, owner }]
  gates: { mode: warn }            # warn | enforce
  ci: { provider: buildkite, queue: <queue>, image: <image>, toolchain: { bun: 1.4.4, node: 24 } }
  receipt: { adapter: core-edge.ship-receipt/v1, gate_paths: [] }   # or none
  proof:
    gates: [{ name: test, command: bun run test, timeout_s: 900 }]
```

## Verifier and receipts

The builder and the verifier are different sessions with fresh context. The verifier records its model provider:

```sh
eng verdict PASS --by <id> --family <family> --provider <provider> --model <m> --session <id> --pr <n>
```

`--provider` accepts any string. Whether that provider's verdicts count is decided by `verifier_providers.trusted` in main's `eng.config.yml` (default: openai, xai, deepseek, moonshot, zhipu, anthropic; google is not trusted).

The record binds the head SHA, the merge-base, the base tip, the head tree (the diff fingerprint) and the patch-id (`refs/notes/eng-verdict`). An adapter turns it into the repo's own format. Adapter 1 is `core-edge.ship-receipt/v1`: a COMMENT review body with the `<!-- core-edge.ship-receipt/v1 -->` marker. Its `diff_fingerprint` is the head tree SHA and its `base_sha` is the base tip. A rebase therefore always needs a new receipt draft. The verdict itself carries over when the patch-id is unchanged and `verdict_carry` is `patch-id`. The lead or the lead's lane posts the draft; the pack never does.

## Gaps this closes

| Repo | Gap | Piece |
|---|---|---|
| Core Edge #373 | supported-provider receipt | `eng verdict --provider` + `eng renovate receipt` (core-edge adapter) |
| Core Edge #373 | up-to-date landing gate | `renovation.merge_policy` + `eng renovate refresh` |
| Infotech #462 | v7 operator | `eng renovate ci-preflight` → `needs-decision: ci-image-operator` |
| Infotech #462 | native proof | `eng renovate prove` ledger with timeouts |
| devbox-ops #4/#5 | filename | `renovation/baselines/secret-filename.json` + scan |
| devbox-ops #4/#5 | full-native 0700 | `eng launch` |
| Todd #13, Website #10 | merge-policy adoption | step 1 |
| Site #2 | fallow baseline, launch contract, TMPDIR, base branch | steps 2 and 7; `os.tmpdir()` instead of `/tmp` in `eng verify create` and `eng laws`; `--base <ref>` / `ENG_BASE` for the verdict base; the rendered pipeline lints against `origin/<default_branch>` |
