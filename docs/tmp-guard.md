# /tmp guard: `eng tmp-guard -- <cmd>` (v0.12.0)

On 27 Oct 2026, kalsigns-platform's `validate:pr` left 366 dirs in the devbox `/tmp` (`feedback-api-test-*`, `feedback-client-*`, `feedback-build-*` and `bff-feedback-*`), and the disk reached 92%. Its tests and builds made temp dirs, and no run removed them. `eng gate` and `eng e2e` already gave their children a per-run `$ENG_TMP`. `validate:pr` was run as a plain package script, so it never got one, and nothing checked what it left behind.

## Contract

| Part | Rule |
|---|---|
| Env var | `ENG_TMP`. `TMPDIR`, `TMP` and `TEMP` are set to the same dir, so `os.tmpdir()`, `mktemp -d` and most tools follow it. `ENG_SCRATCH` is the round dir, and `ENG_TMP_BASE` is the scratch root. |
| Root path | `<hygiene.scratch_root>/eng-<repo>-<ts36>-<pid>-tmp-guard-XXXXXX/tmp`. The default scratch root is `${XDG_CACHE_HOME}/eng/<repo>/scratch`, which is never under `/tmp`. A nested eng (`eng gate` inside the guard) reuses the same `ENG_TMP`, so one run has one root. |
| Permissions | The round dir and its `tmp/` are created with mode 0700. |
| Cleanup | When the command exits, passes, fails or gets SIGINT/SIGTERM/SIGHUP, eng stops everything the round started (its process group, live descendants and any process whose environment has this round's `ENG_SCRATCH`). Then it removes the round dir. A signal goes to the command first, and eng exits `128+n`. Only SIGKILL to eng itself leaves the round behind. `eng clean --apply` removes those dirs. |
| Guard | Before the command starts, eng takes a snapshot of the top-level entries of each `hygiene.tmp_guard.dirs` dir (default `[/tmp]`). The snapshot records each entry's path, inode and owner uid. eng takes a second snapshot after the round is removed. The run fails when an entry in the second snapshot is attributed to the run (rules below). eng prints each entry as `LEAK <path>` and deletes none of them. |
| Exit | A failing command keeps its own exit code, and leaks are still printed. A passing command with leaks exits 1. Otherwise the exit code is 0. |
| Trigger | Only an explicit command. Nothing runs it on a schedule. Use it in package scripts (`"validate:pr": "eng tmp-guard -- bash scripts/validate-pr.sh"`), in CI steps (`npx --no-install eng tmp-guard -- pnpm test`), or around a whole local verify (`eng tmp-guard -- eng gate`). |

## Attribution rule

eng checks each entry in the second snapshot. An entry whose path and inode were both in the first snapshot existed before the run and is skipped. eng tests every other entry against these rows in order, and the first row that matches decides. Only `run` fails the guard.

| Order | Who | Matches when |
|---|---|---|
| 1 | `other-user` | The entry's owner uid is not the uid of the user running the guard. |
| 2 | `other-repo` | The entry name has the eng run-dir shape of another repo: `eng-<repo>-<8 base36 chars>-<pid>-…` (`engTmp`, `openRound`, `.eng/test-tmp.mjs`) or `eng-launch-<repo>-XXXXXX` (`eng launch --keep`), where `<repo>` is not this repo's slug. |
| 3 | `ignored` | The name matches a glob in `hygiene.tmp_guard.ignore` or a `--ignore '<glob>'` argument. `*` matches any characters except `/`. |
| 4 | `run` | Any other entry. It is new (its path and inode were not there before), it is owned by the run user, and it is not excluded by rows 2 or 3. |

The code for this table is `TMP_ATTRIBUTION` in `lib/hygiene.mjs`.

## Limits

- **Concurrency on a shared user.** Nothing records which process made a file, and eng does not use fanotify (it needs root) or strace. Row 4 therefore assumes that a new entry owned by the run user came from the run. On the devbox every agent runs as `dev`, so an entry another agent makes during the run window also counts. Measured on 27 Oct 2026: while this repo's tests ran, other agents made 21 new top-level `/tmp` entries in 45 seconds (`opus-r3-home-*`). A later guarded run of this repo's own suite reported 5 `feedback-build-*` dirs. Those came from the kalsigns leak, which was still running in another session. When a local run reports an entry your code does not make, run the guard again before you act on it. CI runners have one job per user and do not have this problem. Use CI as the authoritative guard.
- **The same repo running twice.** Two concurrent runs of one repo see each other's leaks. Both runs then fail for the same code.
- **Top level only.** eng compares only the entries directly under each watched dir. A run that writes inside a dir that already existed (`/tmp/shared-cache/…`) is not detected.
- **Entries made and removed during the run** are not growth and are not reported.
- **A recreated entry counts.** An entry that is deleted and recreated at the same path gets a new inode, so it counts as new.
- **Prefix overlap.** Repo slugs can contain `-`, so `eng-kal-…` and `eng-kal-signs-…` could look alike. eng keeps them apart with the `<8 base36 chars>-<pid>-` run-id shape. An entry that does not have that shape is never treated as another repo's.

## Finding runs that bypass the per-run root

`eng renovate audit` item `tmp-root` (step 7) and an `eng doctor` warn row (warn only, it never fails doctor) read the same facts, `tmpRunFacts` in `lib/hygiene.mjs`:

- **Runs.** A run is a package script (any `package.json` outside `node_modules`, `vendor` and `fixtures`) whose name starts with `test`, `build`, `validate`, `verify`, `e2e` or `ci`, or a script that calls a test or build runner (vitest, jest, mocha, `playwright test`, `node --test`, `bun test`, `deno test`, `cargo test|build|nextest`, `vite build`, `next build`, `turbo run test|build`). A CI step (`.github/workflows`, `.buildkite`, `.eng/ci`, `.gitlab-ci.yml`) that calls such a script or runner is also a run. `npm ci` is not a run.
- **Rooted.** A run is rooted when its command goes through `eng tmp-guard`, `eng gate`, `eng e2e`, `eng launch`, `eng verdict round` or `eng renovate prove`, or sets `ENG_TMP=` or `TMPDIR=`. A CI step that calls a root package script that is rooted is also rooted.
- **Guarded.** A repo is guarded when any CI line or package script calls `eng tmp-guard`.

`eng renovate apply launch` prints each run that is not rooted, with the wrapped form to use instead. It does not edit `package.json` or CI files.
