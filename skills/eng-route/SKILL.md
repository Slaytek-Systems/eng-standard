---
name: eng-route
description: "Which skill to use at each stage (plan, build, verify, ship, retro), and how to name it when you spawn or steer a coding thread. Use when starting, spawning or steering a thread, or when unsure which skill fits."
---

# eng route

To use a skill, read `.agents/skills/<name>/SKILL.md` and follow it. Do not rely on description matching or the Skill tool: most skills here are manual-only and will not load on their own.

## Starting or steering a thread

This is the primary path. A lead that spawns or steers a coding thread (for example in T3) starts the message with one line naming the mode and the playbook, then the job:
- `/poteto-mode -> Shipping playbook: verify commit <sha> with verify-<app>, record eng verdict`
- `/poteto-mode -> Babysit playbook (drive): get PR #<n> to merge-ready`
- When steering mid-task: `/poteto-mode -> Switch to the Shipping playbook` or `Run blast-radius on this diff`.

Which playbook goes with which job (poteto-mode playbooks, `.agents/skills/poteto-mode/playbooks/`):

| Job | Playbook | File |
|---|---|---|
| Drive the author's own PR to merge-ready (conflicts, review threads, CI). Not an independent review | Babysit | `babysit.md` |
| Independent verdict by an agent that did not write the code, then land | Shipping (verification) | `shipping.md` |
| Full autonomous program: one owner per PR from build to merge | Autopilot-full | `autopilot-full.md` |
| Full autonomy up to a verified stack the operator lands | Autopilot-stack | `autopilot-stack.md` |
| Bug fix / feature / refactor | Bug fix, Feature, Refactoring | `bug-fix.md`, `feature.md`, `refactoring.md` |

Rules for the message:
- Babysit is not review. The verdict comes from a separate Shipping spawn by an agent that did not write the code.
- When the change adds a surface (route, screen, command, API, job) the repo's `verify-<app>` skill does not cover, the spawn must require `maintain-verification-skill` for that surface before the verdict.
- Plain prose with normal spacing between words. Re-read before sending; never send a message with its spaces stripped out.

The router below (also in AGENTS.md) is the fallback when no skill was named.

## Router

- **plan:** `poteto-mode` (it picks the playbook: bug-fix, feature, refactoring ...), then `how` / `why` / `architect`; `figure-it-out` for large work; `grilling` / `grill-with-docs` for product calls; `find-the-laws` for rules that must always hold.
- **build:** the playbook steps; `tdd` for bug fixes; `typescript-best-practices` on every .ts/.tsx edit; `show-me-your-work` for long or unattended runs.
- **verify:** `principle-prove-it-works`, the repo `verify-<app>` skill (use it wherever pstack says `control-cli` / `control-ui`), `eng verify create <id>`; `statechart` for a flow that moves between states, `create-formal-verification-skill` for non-stateful high-cost code (`formal` in eng.config.yml); `interrogate` for contested design, `blast-radius` for small risky diffs.
- **ship:** author: the Opening a PR playbook (`no-comments`, then `technical-writing` + `unslop`) up to merge-ready, never merge. Shipping manager: the loop below.

## Shipping (serial, one PR at a time)

Author stops at merge-ready (gate green, description, evidence, risk label). A fresh-context verifier records the verdict on the head SHA. The shipping manager (repo lead) is the only one that merges, reverts and reorders, and never writes code. Matt only approves `risk:high` (auth, payments, schema/migrations, public APIs, CI, production data) and never presses merge.

Loop, whenever a PR becomes ready (`eng ship next` prints the next PR and the commands):
1. Oldest ready PR with a PASS verdict; skip `risk:high` not yet approved.
2. `gh pr update-branch <n>`.
3. Wait for the gate on the new head. Same patch-id: verdict stands. Otherwise back to the verifier.
4. `gh pr merge <n> --squash --delete-branch --match-head-commit <sha>`.
5. Main green after merge, else revert now and return the PR to its author.
6. Log it in the repo's Core status note.

Two gate failures: back to the author with the reason. `risk:high`: send to Matt as soon as ready, one at a time, with a one-line summary, evidence and PR link; merge once he approves. Full SOP: `SHIPPING.md`. TODO: releases and tagging.
- **retro:** `eng-retro` (`eng retro`) after each merged PR, then `correct` for any class it finds.
