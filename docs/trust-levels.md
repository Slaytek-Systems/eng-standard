# Trust levels (PROPOSAL)

Status: proposal. eng validates a `trust:` block in `eng.config.yml`, but no gate, workflow or merge path reads it yet.
Turning it on is a separate decision for Matt. Why it exists: [principles/slow-down-to-speed-up.md](../principles/slow-down-to-speed-up.md).

## Levels

| Level | What agents may do alone | Evidence to reach it (example values) |
|---|---|---|
| `draft-only` | open PRs; a human merges | none: every repo starts here |
| `merge-on-verifier-pass` | merge after an independent verifier PASS on the exact head | 10 consecutive independent verifier PASSes and at least 14 days at `draft-only` |
| `deploy-on-own` | merge and deploy without a human | 25 consecutive independent verifier PASSes and at least 30 days at `merge-on-verifier-pass` |

A repo moves up one level at a time. Evidence counts from the last level change.

## Demotion

Automatic, on any one event: a declared check failing on the default branch (`failed_check`), a `revert` or a `rollback`.
Each event maps to `one-level` or `draft-only`. When several happen at once, the harshest wins. A demotion resets the
evidence, so every promotion means zero crashes since the last level change.

## Checks and where they run

`trust.checks` lists the checks the repo runs (pstack, e2e, bend2, linters) and where each runs: `local`, `cloud` or
`sandbox`. `runner` is an optional adapter name such as `buildkite` or `boat`. It is a name only: eng holds no vendor
logic for it.

## Config

```yaml
trust:
  level: draft-only
  promote:
    merge-on-verifier-pass: { consecutive_verifier_passes: 10, min_days: 14 }
    deploy-on-own: { consecutive_verifier_passes: 25, min_days: 30 }
  demote: { failed_check: one-level, revert: draft-only, rollback: draft-only }
  checks:
    - { name: pstack, runs: local }
    - { name: e2e, runs: sandbox, runner: boat }
    - { name: bend2, runs: local }
    - { name: lint, runs: cloud, runner: buildkite }
```

Validation: `trustErrors` in `lib/trust.mjs`, called from eng's config schema. The level rule: `nextLevel(trust, evidence)`.
Tests: `test/trust.test.mjs`. The same block ships commented out in `templates/eng.config.yml`.
