# Contextual init for a repo that already ships (`eng init`)

There is one standard and one init (Matt, 6 Nov 2026; Core nd71bs9kx7rnwphcj0jhp50b1n8hpk4d). `eng init` looks at the repo in front of it and applies the same bar. An empty repo gets the starter `eng.config.yml`. A repo that already ships gets a config built from what is there, and keeps what it has today passing while new findings fail. It never merges, never bypasses protection, never edits rulesets and never touches prod. It writes files on a branch; the lead reviews, commits and opens the PR, and that PR goes through the repo's own gates and verifier.

Until 0.14.0 this was a separate `renovate` command with seven adoption steps. The 6 Nov 2026 CLI cut folded it into `eng init`.

## What `eng init --owner @policy-owner` writes in a repo that already ships

| File | What |
|---|---|
| `eng.config.yml` | seeded from `templates/eng.config.yml` with this repo's name, default branch and test command, `gates.required: [lint, test]`, and a `renovation:` block (`version`, `policy_owner`) |
| `.github/CODEOWNERS` (or the repo's existing one) | `/renovation/baselines/ @policy-owner`, so a baseline edit needs the owner |
| `renovation/baselines/secret-filename.json`, `lint.json` | the findings the repo has today, written once. Re-running init never baselines a new finding |
| everything `eng sync` renders | AGENTS.md, SHIPPING.md, hooks and skills. SHIPPING.md keeps the repo's own stricter rules between `<!-- renovation:local -->` and `<!-- renovation:local:end -->`; a pre-existing SHIPPING.md goes there whole. `renovation/divergences.md` lists each local rule |

`eng lint` then fails only on new findings: lint rule hits and credential-looking filenames that are not in the baselines. `renovation.gates.mode: warn` reports instead, but `eng lint --config-from origin/<base>` takes the mode from the base, so a branch cannot soften its own check. `eng sync --check` covers SHIPPING.md and `renovation/divergences.md`.

## Config

```yaml
renovation:
  version: 0.14.0                  # pack version that wrote the block
  policy_owner: "@lead"            # owns renovation/baselines/ in CODEOWNERS
  merge_policy: { strict: false }  # strict: true is a divergence, recorded in divergences.md
  divergences: []                  # [{ rule, standard, local, reason, owner }]
  gates: { mode: warn }            # warn | enforce
```

Keys earlier versions wrote (`completed_steps`, `verdict_carry`, `receipt`, `proof`, `ci`) are ignored. A verdict counts only for the exact commit it ran on, and `eng gate` runs the repo's verifiers.

## T3 message delivery and queue health (unrelated to init)

A `queued` result from `t3_thread_send` means T3 stored the message. It does not confirm that a run started. Check `t3_thread_read` activity or `t3_thread_wait` for a new run. For time-critical or approved sends, use `mode: "auto"` and confirm that the run started.

Run the queue-age check on demand from an eng-standard checkout with `node lib/t3-queue-health.mjs snapshot.json`. The default age limit is 30 minutes. Set another limit with `--minutes N`. The command exits 1 when it finds a queued item older than the limit. It exits 2 when the snapshot is invalid. It does not run on a timer, schedule, loop, or daemon.

The JSON snapshot has a `threads` array. Each thread has a `threadId`, an optional `title`, and an `items` array. Each item has a `queuedRunId` and an ISO 8601 `createdAt` timestamp.

```json
{
  "threads": [
    {
      "threadId": "thread-id",
      "title": "Coordinator",
      "items": [
        { "queuedRunId": "queued-run-id", "createdAt": "2026-10-27T10:00:00Z" }
      ]
    }
  ]
}
```

Build the snapshot from the coordinator's thread list, each thread's queue list, and each thread's recent runs. Match `queuedRunId` to the run's `runId` and copy its `requestedAt` value into `createdAt`. The checker rejects missing, malformed, or future timestamps. It escapes control characters in warnings so thread metadata cannot add output lines or workflow commands.

The checker reports the thread, queued run, age, and configured limit.
