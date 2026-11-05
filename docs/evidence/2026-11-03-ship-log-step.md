# Configurable shipping log step

Motus Lead decision `nd7922184grhk1zvgsn2cgx9fx8hh52w`, 3 Nov 2026.
Base `c7db095b6a88f8450d44a6f03efdc84b138866bc`, branch `feat/ship-log-step`.

## Outcome

PROVEN locally. SHIPPING.md defaults to logging the PR number, merge SHA and main's post-merge result on the PR's Core task, with decisions in separate notes and no writes to the repo's Core status note. An optional string, `ship.log_step`, replaces the step text verbatim. The CLI uses the same default and override. The copied eng-route skill carries the default.

The CLI journey runs in a temporary consuming repo. It writes default and custom config, runs `eng sync`, reads SHIPPING.md and runs `eng drift-check`. Both configurations pass. A separate CLI check reads a ready PR through fake GitHub responses and verifies the printed logging step. No real PR is merged by these checks. `eng sync` was not run on eng-standard itself.

## Validation

- Tests were added before implementation. The initial focused run exited 1 with five failing new tests and one passing existing test. The later CLI consistency regression also failed before its fix.
- Final `node --test test/ship.test.mjs` exited 0. Seven tests passed, none failed or skipped.
- Final `npm test` exited 0. Of 300 tests, 281 passed, none failed and 19 skipped. The skipped isolation tests require a usable bubblewrap environment with scratch outside `/tmp`; they do not prove isolation enforcement here.
- Coverage includes the exact default, the removed instruction, copied skill text, custom whitespace, multiline strings, empty strings, dollar replacement sequences, template tokens, non-string rejection, CLI output and generated-file drift.
- `node --check` passed for `bin/eng.mjs`, `lib/render.mjs` and `test/ship.test.mjs`. `git diff --check` passed. The skill frontmatter validator passed.
- No lint or format npm script is defined. The package's `node bin/eng.mjs lint` command was also run and exited 1 with 27 findings. Every offending source line is present at the base commit. The findings are in existing fixture, test, vendored and scratch code, including the existing scratch call in `bin/eng.mjs`. None comes from an added line. Rules and baselines were left intact.
- No fixture or golden file contains the changed shipping-loop text.

## Choices

Model the Domain kept the data shape as an optional string in the existing ship mapping. Boundary Discipline put its type check in the existing config validator. Laziness Protocol kept one shared function for the CLI and renderer. Test Behavior, Not Implementation and Prove It Works selected generated text, drift-check and CLI observations as the proof. Build the Lever is the committed regression suite.

The SHIPPING insertion runs last and uses a replacement callback so custom dollar sequences and template tokens remain literal. Version 0.12.3 follows the patch convention for a rule addition to an existing config area. Consuming repos see SHIPPING.md and eng-route changes on their next sync.

Diff hygiene used unslop and a direct comment inspection in place of deslop and Comment Sicko. The brief prohibits helpers. No comments were added to application code and none were removed. No helper, verdict, merge, rebase, force push or hook bypass was used.

## Handoff

The implementation is ready for the parent to arrange independent review. Hosted CI and an independent verdict remain separate evidence. The workflow assigns the risk label after the PR opens. No review or merge readiness is claimed here.
