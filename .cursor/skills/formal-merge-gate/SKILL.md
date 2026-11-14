---
name: formal-merge-gate
description: Model-check eng-standard's self-merge gate (lib/self-merge.mjs decide(), the run guard, verdict counting, and the re-check in scripts/pr-gate.mjs merge()) over every order of GitHub events within stated bounds, running the real decide(). Use before and after any change to lib/self-merge.mjs, the run-status helpers in lib/verification.mjs, the reads in scripts/pr-gate.mjs merge() or prState(), ship.self_merge in eng.config.yml, or the merge rule in AGENTS.md.
---

# Formal check: the self-merge gate

Self-merge is the only way code lands on this repo's `main`, so a wrong merge decision ships unverified code. The unit tests (`test/self-merge.test.mjs`, `test/gate-inputs.test.mjs`) check chosen inputs. This check runs every order of verifier, collaborator, CI, builder and self-merge events that the bounds allow. At each re-check it calls the real `decide()` on status rows and verdict comments, built with the product's own encoders (`runStatusContext`, `runStatusText`, `verdictBody`, `parseVerdicts`).

All commands run from the repo root after `npm ci`. `F=.cursor/skills/formal-merge-gate`. Codex and Claude Code do not discover `.cursor/skills/`, so read this file by path.

## The property

**RulesHeldWhenRead** (the default): self-merge merges a head only if every merge rule held for that head as of the moment it read each input. The rules are: exact head, no hold label, the head contains main's tip, `test` green, the latest `verdict` status is success, no FAIL as any verifier's latest verdict, and enough counted PASSes. risk:low needs 1. risk:high needs `ship.high_risk.verifiers` distinct `--by` names. A PASS counts only from a `verifier_logins` login and only while that verifier has no run in progress. The harm if it breaks is that main gets a head the merge rule refused.

`rulesHold()` in `check.mjs` judges this from what happened: who started which run, who ended or cleared it, and which comments exist. It never reads status rows, so a bug in how `decide()` reads rows shows up as a disagreement.

**MergeMatchesAMoment** (`--property moment`): one moment existed, between the re-check's PR read and the merge call, when every rule held at once. It fails today on finding F1 below.

## Run it

```sh
node --max-old-space-size=1500 $F/check.mjs                      # RulesHeldWhenRead, all 6 scenarios: about 15 s, under 1 GB
node --max-old-space-size=1500 $F/check.mjs --property moment    # fails today on F1 only
node $F/sensitivity.mjs                                          # every seeded fault must be CAUGHT: about 15 s
```

`--scenario <name>` runs one scenario. `--src <checkout>` checks another checkout, such as a PR head in another worktree. Run the commands one at a time; they need no network and no extra tool. Exit 0 means the property held and every witness was reached. Exit 1 means a counterexample, printed as its shortest path. Exit 2 means the result proves nothing: a witness was never reached (`VACUOUS`), the state cap was hit (`INCOMPLETE`), or a fault anchor is stale (`STALE`). Never raise `--max-states` or widen a scenario to get past `INCOMPLETE` on a shared machine. Narrow the scenario instead.

## Scenarios and bounds

One self-merge run on one PR. Verifiers `V1` and `V2` post as the `verifier_logins` login (`Mattslayga`, OWNER). `collab` is a COLLABORATOR who is not listed. Runs use a 60 s timeout. Every scenario is searched to the end.

| Scenario | Tier | What can happen (at most) |
| --- | --- | --- |
| `run-ownership` | low | 6 events: 1 run by either account, 2 verdicts, 2 foreign or manual statuses on a run (`collab` success, `collab` pending with timeout 0 s, the login's `error` clear), 1 clock jump |
| `dead-runs` | low | 6 events: 2 runs, 1 verdict, 1 eng death, 1 clock jump to a deadline or one second before it |
| `two-verifiers` | high | 5 events: 1 run, 3 verdicts from V1 and V2 |
| `heads` | low | 6 events: 2 verdicts, 2 verdict statuses, 1 push, main moves once, CI on each head |
| `hold-label` | low | 4 events: 2 verdicts, the hold label added and removed |
| `f1-replay` | low | 6 events: 2 runs, 3 verdicts, all by the login. Self-merge's first `decide()` pass runs read by read here, so a counterexample is a full replay of `merge()`. |

Verdicts are a PASS or FAIL by the login, or a PASS by `collab`. Each scenario must reach its witnesses (`EXPECT` in `check.mjs`). Each witness requires that self-merge read the event it names. One example is a merge that counted a PASS after the dead run's pending status was read and `now` was past its deadline. Another is a refusal where `collab`'s success on the login's live run was read, with the test green, no hold label and the verifier's latest read verdict a PASS. A pass where nothing merges proves nothing.

## What maps to the code

| Model | Code |
| --- | --- |
| `ctrlMoves`: `idle` (main's tip), `pr` (the PR) | `merge()`: `mainTip()`, then `prsFor()` |
| first `decide()` pass | `merge()`: `evaluate(p, tip)`. It only gates the re-check, so every scenario except `f1-replay` takes it as merge. That allows more behaviors than the code has, never fewer, so a pass is sound. A counterexample from those scenarios is abstract, so replay it in `f1-replay` or a scenario like it before you call it a bug. |
| `again` (head, hold label, main unchanged) | `merge()`: `again = get(pulls/n)` and `mainTip()`, two reads modeled as one step. Main cannot move during the run, and the head is pinned by the merge call. |
| `s`, `k`, `b`, `v`: statuses, then `test` check and `now`, then compare, then comments and `decide()` | `prState()` in that order, then `evaluate()` and `decide()` |
| `put`: merge, refused if the head moved | `PUT pulls/n/merge` with `sha` |
| run start, end, `error` clear, `collab` statuses | `lib/run.mjs` posts through `runStatusContext` and `runStatusText`, and docs/self-merge.md "Run guard" covers the hand clear |
| `rulesHold()` | AGENTS.md "Merge rule" and docs/self-merge.md, restated without `lib/` |

## Assumptions and what is left out

- **Environment.** `eng run`'s budget ends a live run before first pending + timeout + 5 minutes, so the clock never passes a live run's deadline. Main moves only between self-merge runs (runs queue one at a time, and nobody merges by hand). GitHub and the runner share one clock. Run ids are random, so nobody can claim a run's context before its run does.
- **Not covered:** risk classification (`riskFor`, `lib/risk.mjs`), `eventTarget`, the auto-revert path, review-only PASSes (`passProblem` with `--review`), PASS+NOTES, edited verdict comments, malformed rows (`parseStatuses`, which `test/gate-inputs.test.mjs` covers), GitHub API errors and pagination, a red `test`, and the merge outcome after the merge call. It does not cover more than 2 verifiers, 2 heads, or more events than the table allows.
- A pass covers these bounds and this model. It does not prove the gate for every history.

## Findings

- **F1: the re-check is not a snapshot** (Core task p571wk5x4dpjwem54zx5nxkvts8j7pa3, needs Matt: the fix is in `scripts/pr-gate.mjs`). `prState()` reads the statuses first and the comments last, seconds apart, and the PR's labels before both. Here is the full replay, with the first pass read by read (`--property moment --scenario f1-replay`, 16 steps). V1 posts PASS. Self-merge's first pass reads it and says merge. V1 posts FAIL. Self-merge re-reads the PR and the statuses, and no run is pending. V1 starts `eng run --by V1`, which posts pending, and then V1 posts PASS while that run is still going. Self-merge reads the comments, counts the latest PASS, sees no run, and merges. After the FAIL, there was no moment when the latest verdict was a PASS and V1 had no run in progress. This is the #73 pattern (PASS, then FAIL, then a re-run) that the run guard exists for. A hold label added just before a late PASS is missed the same way. `--property moment` fails in `run-ownership`, `dead-runs`, `two-verifiers`, `hold-label` and `f1-replay`, and passes `heads`. When F1 is fixed, `--property moment` must pass every scenario. Then make it the default and drop this entry.

## Reading a result

- **FAIL** prints the shortest path as numbered steps in the code's words. Replay each step against the code in the table above. If a step cannot happen in reality, the model is wrong: fix the step or state the assumption above. For example, main moving during a self-merge run cannot happen, and the model forbids it. If every step can happen, it is a bug. Report it with the path, file it as a Core task, and never weaken `rulesHold()` or a scenario to make it pass.
- **VACUOUS** means a witness was never reached, usually because a change made merges unreachable in that scenario. Find out why before you trust any PASS from it.
- **STALE** from `sensitivity.mjs` means the code moved. Update that fault's `from` and `to` so it breaks the same rule in the new code, and confirm it is CAUGHT.

## When the code changes

1. Check for drift: `git diff ae2ac73a314b8f6f89eba908ef41d1964bb0872b..HEAD -- lib/self-merge.mjs lib/verification.mjs scripts/pr-gate.mjs eng.config.yml AGENTS.md` (the sync commit below).
2. Run `check.mjs` and `sensitivity.mjs`, then `check.mjs --property moment` to see whether F1 still stands.
3. For an intended rule change, change `rulesHold()` to the new contract, and cite the decision in the commit. For a new event, such as a new writer of statuses or comments, a new read in `prState()`, or a reordered read, add it as an environment event or a controller step. Then add a fault to `sensitivity.mjs` that breaks it.
4. Confirm that the table above still describes the code. Then move the sync commit to the commit you checked. Never move it for a check that did not pass, or that you did not confirm against the code.

## Coverage record

| Covered | Functions |
| --- | --- |
| `lib/self-merge.mjs` | `decide`, `verdictGate`, `runsInProgress`, `parseStatuses` (well-formed rows only), `trusted`, `parseVerdicts`, `verdictBody`, `selfMergeConfig` |
| `lib/verification.mjs` | `runDeadline`, `runStatusBy`, `runStatusContext`, `runStatusText`, `passProblem` (verification PASSes only) |
| `scripts/pr-gate.mjs` | `merge()` and `prState()`: the order of the reads and the re-check (modeled, not run) |
| `eng.config.yml` | `ship.self_merge`, `ship.high_risk.verifiers` (read through `selfMergeConfig`) |

Sync commit: `ae2ac73a314b8f6f89eba908ef41d1964bb0872b`. At this commit the model, the scenarios and the faults were confirmed against the covered code: RulesHeldWhenRead PASS in all 6 scenarios, 10 of 10 faults CAUGHT, and MergeMatchesAMoment failing only on F1. The maintenance method is `/maintain-formal-verification-skill` (`vendor/pstack/skills/maintain-formal-verification-skill/SKILL.md`).
