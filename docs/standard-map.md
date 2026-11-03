# Map of the standard's entry points

Every place an agent or a person can land and learn the standard, what each one covers, and what the 0.14.0 sweep
(3 Nov 2026) found and fixed. The questions are: (a) how the standard stays current, (b) how to use it day to day,
(c) how to onboard a repo or an agent and configure it, (d) how to renovate a brownfield repo, and (e) uninstall,
exceptions and waivers, and where to report a problem. The guide that answers all of them is [lifecycle.md](lifecycle.md).

## Who answers which question (after 0.14.0)

| Question | First stop in a client repo | Detail | Enforced by |
|---|---|---|---|
| (a) Which version, pinned how | AGENTS.md "This standard" | lifecycle.md, Pin | `eng drift-check` (floating pin, lock version) |
| (a) How to upgrade | AGENTS.md "This standard" | lifecycle.md, Upgrade; CHANGELOG.md | `eng upgrade-check` |
| (a) What changed | `eng upgrade-check` | CHANGELOG.md (shipped in the package) | `test/docs.test.mjs` (version agreement) |
| (a) Drift | AGENTS.md "Rule → enforcer" | lifecycle.md, Drift detection | `eng drift-check` in pre-commit and gate `drift` |
| (b) Day to day | AGENTS.md block, SHIPPING.md | skills under `.agents/skills/` | `eng gate`, the verdict gate |
| (c) New repo | AGENTS.md "This standard", README "Start here" | lifecycle.md, New repo | `eng init`, then `eng drift-check` |
| (c) New agent | AGENTS.md block | lifecycle.md, New agent | commit trailers read by the verdict gate |
| (c) Configure | `eng.config.yml` comments | `templates/eng.config.yml` | config validation on every `eng` command |
| (d) Brownfield | AGENTS.md "This standard" | renovation/README.md | `eng renovate audit/plan/scan/render --check` |
| (e) Exceptions | AGENTS.md "This standard" | lifecycle.md, Exceptions and waivers | the check named per kind in that table |
| (e) Uninstall | AGENTS.md "This standard" | lifecycle.md, Remove | `eng uninstall` (dry run by default) |
| (e) Report a problem | AGENTS.md "This standard" | lifecycle.md, Report a problem | none (judgment) |

## Entry points

| Entry point | Covered before | Missing before | Stale or contradicting before | Fixed in 0.14.0 | Still open |
|---|---|---|---|---|---|
| Rendered AGENTS.md block (`lib/render.mjs`) | (b) fully: commands, skill router, spawn rules, CI hygiene, rule → enforcer, merge, fixed rules 16 to 21 | (a), (c) beyond its own text, (d), (e): nothing said where the standard lives, which version rendered it, how to upgrade, remove, waive or report | told agents to push rebased feature branches with the force-with-lease flag, which Matt's rules block | new "This standard (eng-standard)" section; pushed history is never rewritten (Matt, 3 Nov 2026), and the block says it overrides pstack's rebase advice | none |
| Rendered SHIPPING.md (`templates/SHIPPING.md`) | (b) shipping SOP, fixed rules 1 to 17, gates, merge, disk and CI hygiene | (a), (e) | rule 1 allowed rewriting pushed feature branches, which Matt's rules block; §7 still says "eng v0" | rule 1 is now "Never rewrite pushed history"; the rendered pre-push hook refuses a non-fast-forward push on every branch and a moved tag; the deny list covers every branch | §7 "eng v0" wording (left for PR #42, which rewrites this file) |
| Rendered STACK.md | stack choices, exceptions, when another language is justified | link to fleet floors | none found | none needed | none |
| eng-standard `AGENTS.md` | the merge rule for this repo | none for its audience | none found | none needed | none |
| `README.md` | command table, vendoring note | (a), (c), (d) as a path; rows for `ci-verdict`, `conform`, `fallow`, `find-laws`, `launch-check`, `retro`, `ship next` | title "v0 (sandbox only)" on 0.12.2; a "Starter pack" heading over T3 queue-health text, with no starter pack under it; "AGENTS.md (Codex/Cursor)" | title, "Start here", all missing rows, T3 text in its own section; `test/docs.test.mjs` now fails on a missing row | none |
| `CHANGELOG.md` | every release since 0.7.1 | link to how to upgrade | preamble said versions follow commit titles; 0.12.2 shipped as `fix(isolation)` | preamble names package.json as the source of truth; test enforces agreement | several `Unreleased` entries sit between versions |
| `docs/lifecycle.md` | did not exist | all of (a) to (e) in one place | n/a | new | none |
| `renovation/README.md` (renovation pack) | (d) fully: steps, commands, config, receipts | how to install eng first | `npx eng-standard@0.9.0` cannot run (package not on npm, wrong name); title pinned to 0.9.0; T3 queue text at the top | install line, title, T3 text moved to the end | none |
| Starter pack (`templates/starter/eng.config.yml`, new) and full reference (`templates/eng.config.yml`) | (c) every key with a comment, in one file | a starter a new repo can pass: the only template was the full standard, and gates like `laws`, `conform`, `launch` failed on a new repo | `e2e.node_bin` pointed at `/workspace/...`, which does not exist; `harnesses` listed `cursor` (inert, never-list) | `eng init` seeds a minimal starter with stage 1 gates; lifecycle.md stages the rest; `test/starter.test.mjs` runs init and gate on an empty repo; full reference keeps every key | none |
| `docs/self-merge.md` | this repo's self-merge, checker command, settings | none | `R=Mattslayga/eng-standard`; "merge queue is not available (user-owned repo)" contradicts docs/merge-queue.md | both fixed | none |
| `docs/merge-queue.md`, `project-isolation.md`, `modern-stack.md`, `trust-levels.md` | their areas | none for their audience | none found | none needed | none |
| eng skills (`skills/*/SKILL.md`) | (b) per-stage method; `eng-stack` points at fleet floors | (a), (e) | none found (every `eng` command they name exists; now tested) | covered by the command-mention test | none |
| Vendored skills (`vendor/`) | pstack, pocock, fallow, pi-intent at pins in `vendor/PINS.txt` | n/a (upstream text, kept verbatim) | written for Cursor (AGENTS.md "Host mapping" translates); pstack's autopilot-full, babysit and shipping playbooks said to rewrite pushed branches, which Matt's rules block | those three sentences are rewritten at install (`vendor/pstack/REWRITES.tsv`); `test/no-force-push.test.mjs` fails if a pin bump brings one back | other pstack steps still say "rebase onto trunk"; the AGENTS.md override covers them |
| CLI (`eng --help`, `eng init`) | usage line; `init` prints the router and ruleset advice | a way to list commands; upgrade and uninstall commands | none found | `eng commands`, `eng upgrade-check`, `eng uninstall` | none |
| `.eng/lock.json` | managed paths and the rendering version | a check that the version matches what is installed | the version was written but never read | `eng drift-check` reads it | the old-format lock reader was due for removal in 0.13.0 (`lib/lock.mjs`) |
| `package.json` (`files`, `version`) | bin, lib, templates, skills, standard, vendor, renovation README | docs and CHANGELOG were not shipped, so client repos could not read them | `scripts/pr-gate.mjs` defaulted to `Mattslayga/eng-standard` | `docs` and `CHANGELOG.md` shipped; owner fixed | none |
| Git tags and releases | `v0.6.1`, `v0.6.2`, `v0.9.0` | tags for 0.9.1 onwards | a tag-based pin could not reach a version after 0.9.0 | `ci.yml` job `release-tag` tags each release commit once its test passes on main; lifecycle.md pins tags | releases 0.9.1 to 0.13.x stay untagged (no hand tagging, per Matt) |
| CI (`.github/workflows/ci.yml`) | `npm test`, leave-nothing, evidence and download checks | any docs check | none | `test/docs.test.mjs` runs inside `npm test` | CI pins Node 20; the Modern Stack floor is 24 |
| `guards/LOG.md` | crash-to-guard log, checked by `test/guards.test.mjs` | link from the problem-report path | none | linked from lifecycle.md | none |

## What this repo now checks about its own docs

`npm test` runs `test/docs.test.mjs` on every PR (the `test` check). See [lifecycle.md](lifecycle.md), "How eng-standard
checks its own docs", for the list. A doc fix that the checks cannot see (wording, a wrong claim) still needs review.
