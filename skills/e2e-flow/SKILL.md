---
name: e2e-flow
description: "Write an end-to-end user flow with the open-source TesterArmy `e2e` runner (Playwright) using exact steps, and keep video and screenshots per commit for taste review. Use for any UI or user-visible change, and before making a new or changed e2e test blocking."
---

# E2E flow

This is the Drive harness of the repo's `verify-<app>` skill (pstack `create-verification-skill`). Add each flow to that skill's feature map, so `maintain-verification-skill` covers it.

Templates ship with eng in `templates/e2e/` (`auth.setup.e2e.ts`, `journey.e2e.ts`, `playwright.config.ts`). Copy them; they are written against Playwright's API, which the `e2e` runner wraps.

## Authoring rules

- **Sign in once.** A setup step signs in and saves the session with `storageState` (`auth.setup.e2e.ts`). Every journey starts from that state (`test.use({ storageState })`). No journey types a password.
- **One short test per user journey.** One thing a user wants done, asserted on what they see. A test that walks three journeys is three tests. Journeys do not depend on each other's order.
- **No repeated modal dismissals.** Dismiss first-run tours, cookie banners and "what's new" dialogs once in setup, or seed the flag that hides them. A journey that clicks the same "Close" as every other journey is a setup bug.
- **Sensible timeouts, no sleeps.** Test 30 s, `expect` 5 s, action 10 s, navigation 15 s (template config). Use web-first assertions (`await expect(...).toBeVisible()`), never `waitForTimeout`. Raising a timeout needs a reason in the PR.
- **Failure evidence.** `trace: 'retain-on-failure'` and `screenshot: 'only-on-failure'`, plus video on. A failing run must leave a trace and a screenshot in `.eng/evidence/<sha>/e2e/`.
- **No retries.** `retries: 0`. Retries hide flakes; the flake rule below finds them.

## Steps

1. Read `e2e.config.ts` and the e2e skill installed by `e2e init` (`.agents/skills/e2e/`). The target starts the app itself (`app.command`).
2. Write the setup step once, then `tests/<journey>.e2e.ts` the way a user moves: `app.open`, `screen.getByRole/getByLabel(...).fill/tap`, `expect(...).toHaveText`. Use exact locators; `agent.*` steps only if `eng.config.yml` → `e2e.model` is not `none`.
3. Call `app.screenshot('<state>')` before and after the key action, so a passing run has stills.
4. Run `eng e2e`. Done: it prints `PASS` and `.eng/evidence/<sha>/e2e/` holds `video.webm` and the screenshots. CI replays only (`CI=1`, `--strict-cache`); it never records.
5. **Prove it bites (required).** Break the behaviour the journey asserts (comment out the handler, change the label), run `eng e2e`, and see it fail on the assertion with the observed text, plus a trace and screenshot. Revert. Put the failing output in the PR. A test you never saw fail does not block anything.
6. **Flake rule.** A new or changed e2e test must pass `e2e.flake_runs` (default 3) consecutive runs before it can be blocking: `eng e2e --flake-check` (exit 0 = BLOCKING). All fail = a real failure; fix it. Mixed results = QUARANTINE (exit 11): mark the test report-only (not a required check, e.g. a separate non-blocking step or `test.fixme` with the issue link), open an issue with the traces from the failing runs, and make it blocking only after it passes `flake_runs` in a row. `eng e2e --flake-check --results pass,fail,pass` classifies runs you already have.
7. When e2e runs: `eng.config.yml` → `e2e.policy`. PRs run it only for app code, routes, DB schema/migrations, deps/build, CI or a `risk:high` label; docs/config/test-only PRs skip. `eng e2e --required` prints the decision; `eng e2e --if-required` is what the gate and CI call. `main` always runs the full suite after each merge; red there = revert at once.
