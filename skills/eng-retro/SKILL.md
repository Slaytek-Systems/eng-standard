---
name: eng-retro
description: "Learning loop for this repo: after a PR or daily, read what went wrong (failed gates, FAIL verdicts, review findings, reverts) and propose one fix per repeated class at the highest level that works. Proposes only. Use for /eng-retro, 'run the retro', or the daily learning pass."
disable-model-invocation: true
---

# eng-retro

This skill copies two upstream skills and adds no new method:
- `retro` (mattpocock/skills, skills/engineering/retro): improve the agent's environment, not the code; every candidate comes from the record; propose only, nothing changes until the user picks; a mechanical violation gets a deterministic check, judgement calls go to the reviewer's standards, AGENTS.md holds navigation pointers; flag no-ops for deletion.
- `correct` (pstack): a class counts once it has happened twice; fix each class at the highest level that works: architecture, then types, then a lint or CI check whose error names the fix, then a test, docs last and only for judgement calls; prove each new check fails on a real past mistake; keep a rule → enforcer table; a rule that exists with nothing enforcing it is a repeat; drop a rule once its mistake can't happen.

## Steps

1. Gather the record. It is read-only: failed CI runs and `eng gate` output on recent PRs, FAIL verdicts (`eng-verdict/v1` PR comments and the `eng-verdict` git notes), review findings, and reverts on the default branch. Group them into classes by cause.
2. For each class, read the commits it cites. Discard any class you cannot trace to a real moment (retro).
3. Pick its level in correct's order. Go higher if you can: one owner or one write path (`add-gate`), types or a Bend law (`write-law-and-proof`), then `custom-lint`, then `property-test` / `eng-verify` / `e2e-flow`, docs last. Say why a higher level did not work.
4. Add the prune candidates: rules nothing has needed, AGENTS.md lines with no enforcer, reviewer-only rules.
5. Present the list to Matt, most severe first. Stop. Do not edit anything.
6. For each item Matt approves: one commit at that level, proven failing on the cited commits (`eng rules prove`, or a check run with `eng run --ref <commit>`), and add the rule to `agents.rules` in eng.config.yml with its `enforced_by`. `eng doctor` fails on a rule with no enforcer.

**Reply:** each class with its evidence, the level picked, the skill to use and why a higher level did not work; then prune candidates.
