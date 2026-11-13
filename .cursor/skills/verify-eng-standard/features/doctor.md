# Doctor

`eng doctor` tells a user whether their repo is on the standard: config, enforcers, merge settings, disk rules, skills and guard wiring, and the installed, rendered and latest eng-standard versions. It exits 1 when it finds a problem.

## Sub-features

- `doctor-versions` prints installed, rendered and latest versions that agree after `eng init`.
- `doctor-guard` reports the Claude Code guard as wired.
- `doctor-clean` exits 0 on a repo `eng init` just set up.

## How to get to it (user POV)

- Run `eng doctor` in the repo, usually right after `eng init` or an upgrade.

## Driving it with verify.sh

Preconditions:

- A repo that `eng init` set up and committed (`init_repo` in `journeys/lib.sh`).

- **Versions.** Run `eng doctor`. Output has `installed <v>, rendered <v> (.eng/lock.json), latest <v>`, where `<v>` is the packed version.
- **Guard.** Output has `ok   claude-code: wired`.
- **Clean.** Exit code is 0.
- **Journey.** `verify.sh journey <id> doctor`.

## Gotchas

- Before 0.22.1 `doctor-clean` failed: `eng init` seeded the example lint rule `no-focused-tests` with `proven_by.fixture: .eng/rule-proofs/no-focused-tests` but not the fixture, so doctor printed `FAIL lint rule no-focused-tests has no proven_by.fixture on disk` and exited 1. Init now seeds the fixture.
- Without `ENG_STANDARD_SOURCE` doctor reads GitHub for the latest version. `verify.sh` always sets it.
