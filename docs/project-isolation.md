# Devbox project isolation (v0.11.0, warn only)

Every project on the devbox runs as one Unix user (`dev`) with one home folder. Shared defaults, such as Convex's `anonymous-agent` state in `~/.convex` and the default port 3210, let one project's tool reach another project's service. On 24 Oct 2026 a commit hook in one project ran codegen against another project's backend. On 25 Oct a reviewer killed another project's test run.

This standard gives each repo three things: an identity file, a helper that starts and stops services only with proof of ownership, and a repo check. The check warns by default. One config switch makes it fail.

**Threat model.** This helper prevents accidental cross-project actions by agents acting in good faith: a tool that picks up another project's default state, a hook that reaches the wrong backend, a reviewer that stops a run it did not start. It is not a security boundary against a hostile agent. Every project still runs as the same Unix user, so an agent that means harm can bypass the helper entirely. Real separation needs per-project OS users or containers; that is a devbox-ops follow-up.

It builds on the devbox-ops `project-boundary` sandbox (devbox-ops PR6 and PR7). The workspace registry stays the source of the project owner, and the sandbox stays the strongest layer where it is active. Nothing here changes the sandbox pilot or its settings.

## The five rules

| # | Rule | What enforces it |
|---|------|------------------|
| 1 | Unique names and state | `.eng/project.toml` declares the project id, owner, port range, state path and named services. `eng isolation check` reports default names (`anonymous-agent`, `default`), default ports (3210, 3211, 6791) with no override, compose files with no unique `name:`, and state outside the checkout |
| 2 | Ownership before acting | Scripts and hooks reach services through `eng connect`, which checks the ownership record (project, owner, checkout, PID and start time) first. The check reports bare `convex`, `docker compose` and `podman compose` in package scripts and hooks |
| 3 | Verify after each step | The helper re-reads the target after each action: PID plus start time, and the service's health path when it has one. `eng connect` prints which target it touched |
| 4 | No secrets in argv | The check reports secret-looking flags with values (`--instance-secret x`, `--token=x`) in package scripts, hooks, shell scripts and compose files. `eng run-service` refuses to start a service whose argv would carry one, and `eng connect` refuses such a command |
| 5 | Only the starter may stop it | `eng stop` acts only when the caller's agent identity matches the record's. The check reports bare `kill`, `pkill`, `killall` and `docker stop/kill/rm` in package scripts and hooks. On the devbox, the PR6 private PID namespace is the hard layer |

## Identity file: `.eng/project.toml`

Start from `templates/isolation/project.toml`. Commit it. It never holds secrets.

```toml
schema = 1

[project]
id = "core-edge"          # unique on the devbox: lower-case letters, digits, dashes
owner = "core-edge"       # the owner in the workspace registry
state = ".eng/state"      # required; inside the checkout; add it to .gitignore
ports = [41000, 41019]    # inclusive; must not include 3210, 3211 or 6791

[placeholders]           # the only variable parts of a connect entry: type port | path | service
dump = { type = "path" }

[[services]]
name = "backend"
command = ["./scripts/backend.sh", "--port", "{port}", "--data", "{state}/data"]
port_env = "PORT"         # optional: env var that also carries the port
health = "/version"       # optional: HTTP path on 127.0.0.1:<port>
ready_timeout_s = 30      # optional, default 30
env = { LOG_LEVEL = "info" }                               # optional, non-secret
connect_env = { BACKEND_URL = "http://127.0.0.1:{port}" }  # optional, for eng connect
connect = [["npx", "convex", "codegen"], ["./scripts/cli.sh", "restore", "{dump}"]]  # what eng connect may run: full argv
```

`command` is argv, run without a shell. `{port}` and `{state}` are filled in. The parser takes a TOML subset: tables, `[[services]]`, strings, integers, booleans, and arrays and inline tables on one line. It rejects anything else with the line number.

Validation fails on: a missing or default id or owner, a missing state path, a state path that starts with `/`, `~` or `$` or contains `..`, a port range outside 1024 to 65535 or containing a default port, no services at all, an unnamed, duplicate or default-named service, a secret flag, a default name or a default port in `command` or in `env`/`connect_env` values, and a secret-looking key (`*SECRET*`, `*TOKEN*`, `*PASSWORD*`, `*API_KEY*`, `*ADMIN_KEY*`, ...) in `env` or `connect_env`, and any key eng sets itself (`HOME`, `PATH`, `ENG_STATE`, `ENG_PORT`, `ENG_PROJECT`, `ENG_SERVICE`, `ENG_SERVICE_URL`, `ENG_SERVICE_PORT`, `ENG_RUN_TOKEN`, the service's `port_env`). `port_env` itself may not name one of those keys. Secrets files may not set those keys either, and eng sets them last.

## The helper

All four commands run from the checkout root and read `.eng/project.toml`. They need Linux `/proc`.

**Only listed commands run (allowlist).** `eng run-service` runs exactly the service's `command`. `eng connect` runs a command only when an entry in that service's `connect = [...]` equals it as the full argv: the same length, the same program string (no PATH or basename matching: `/usr/bin/docker` does not match `docker`), and every other element identical or a declared `{placeholder}`. An argument that is not listed can never appear, so flag and subcommand variants (`deno eval`, `compose up --remove-orphans --force-recreate`) are refused. Commands run as argv, never through a shell.

Placeholders are declared under `[placeholders]`, each filling one whole argv element. Only three built-in types exist; there are no regex or free-form placeholders, and any other spec is refused as an unknown type: `port` (inside `project.ports`), `path` (every value is resolved against the checkout with symlinks followed, and the result must stay inside it; `/`, `~` and `..` are refused outright), and `service` (a service name from this file). A placeholder value never starts with `-`.

Identity-file validation checks every `command` and `connect` entry, so a bad entry is refused before anything starts:
- a launcher that only runs other commands (`env`, `xargs`, `sudo`, `nohup`, `timeout`, `busybox`, ...) cannot be listed; list the program itself;
- an interpreter (`node`, `python`, `sh`, `bash`, `npx`, `npm`, ...) must be followed by the script, module or package it runs, not an option, so inline code (`node -e`, `python -c`, `sh -c`) cannot be listed;
- `kill`, `pkill` and `killall` cannot be listed;
- docker and podman need an approved subcommand (`compose`, `ps`, `version`, `info`, `images`); compose needs an approved subcommand (`up`, `ps`, `logs`, `config`, `exec`, `run`, `build`, `pull`, `images`, `top`, `port`, `version`, `ls`, `events`) and a real `-p`/`--project-name` naming this project before it. Stopping and removing (`stop`, `kill`, `rm`, `down`, `restart`, `pause`) go through `eng stop` only;
- no secret-looking flag with a value.

At runtime `eng connect` also runs the entry checks on the concrete argv after placeholders are filled (compose targeting, secret flags).

**Destructive operations are never allowed**, even when listed. Any docker, podman or compose argv that contains a destructive verb or flag is refused by identity validation, refused at runtime, and flagged by the repo check (`bare-kill`). Stopping, killing and removing go through `eng stop` only.
- Verbs anywhere in the argv: `stop`, `kill`, `rm`, `down`, `restart`, `pause`, `unpause`, `prune`, `rmi`, `remove`, `delete`, `purge`, `scale`, `update`, `wait`, `attach`. A service or argument with one of these names is refused too (fail closed).
- Flags: `-v`/`--volumes`, `-V`/`--renew-anon-volumes`, `--remove-orphans`, `--force-recreate`, `--always-recreate-deps`, `--rmi`, `--rm`, `--force`, `--prune`, `--purge`, `--abort-on-container-exit`, `--exit-code-from`, `--timeout`/`--time`, `--signal`, `--kill`. Any other single-dash flag after the compose subcommand is refused as well, except `-d`, `-q` and `-a`. Put anything that needs a shell in a script file inside the checkout and list the script.

| Command | Does |
|---------|------|
| `eng run-service <svc> [--secrets-stdin]` | Refuses while this checkout's previous run of the service is alive, or while its leader is gone but token-carrying processes remain in its group (the record is kept so `eng stop` can reap them). Then, under a lock shared by every project (a Linux abstract Unix socket the kernel frees only when its holder exits, so a paused or slow start keeps it; others wait up to `ENG_LOCK_WAIT_S`, default 20 s, then fail without starting), picks the first free port in `project.ports` that no live record of any project holds, makes `<state>/<svc>` (0700) and uses it as `HOME`, scrubs inherited `CONVEX_*`, loads secrets, starts the command in its own process group, writes the ownership record, then waits until the process is still the same one and the health path answers 2xx from a socket the service's own process group holds. The state path may not contain a symlink and must resolve inside the checkout. The ownership directory is created before the service starts, and any failure after the start stops the service. Output goes to `<state>/<svc>/service.log` (0600) only when no secrets were loaded; otherwise it is discarded, because raw output can echo a secret |
| `eng connect <svc> -- <cmd...>` | Checks the record, that every listening socket on the recorded port belongs to the recorded process or its group (so a port another project took over is refused), and health; runs the command with `ENG_SERVICE_URL`, `ENG_SERVICE_PORT`, `connect_env` and `.eng/secrets/<svc>.connect.env`, with `CONVEX_*` scrubbed. It refuses any command not listed in `connect`, then checks compose targeting and secret flags on the full argv (see above). Then checks the record, listener owner and health again and reports the target it touched. When secrets are loaded, the command's output is streamed through a filter that replaces every loaded value with `[redacted]`, so keep non-secret settings out of `.connect.env` (a short value such as `1` would be redacted everywhere it appears). Exits with the command's code, or 1 when the target changed |
| `eng stop <svc>` | Refuses unless the record is for this service, project, owner and checkout, and the caller started it. Sends SIGTERM to the recorded process and every member of its process group that carries the run's `ENG_RUN_TOKEN` (so children that outlive the leader are stopped too), waits up to 10 s, then SIGKILL. Verifies they are gone and removes the record. A record with no matching process left, or one from an earlier boot (its boot id differs), is reported as stale and removed without sending any signal |
| `eng status` | Lists this project's records from every checkout: ok, unhealthy or stale, with PID, port and starting agent |

### Ownership records

`$XDG_STATE_HOME/eng/owners/<project>/<svc>-<checkout hash>.json` (default `~/.local/state/eng/owners`), mode 0600 in a 0700 directory:

```json
{ "schema": 1, "project": "core-edge", "owner": "core-edge", "service": "backend", "checkout": "/abs/checkout",
  "pid": 12345, "pgid": 12345, "start_time": "98765432", "boot_id": "...", "port": 41000,
  "state": "/abs/checkout/.eng/state/backend", "agent": "<thread id>", "started_at": "2026-10-26T..." }
```

`start_time` is field 22 of `/proc/<pid>/stat`, and `boot_id` comes from `/proc/sys/kernel/random/boot_id`. Together with the PID they name one process; a reused PID never matches. `token` is a random per-run value the service and its children get as `ENG_RUN_TOKEN`. eng signals a group member only if its environment carries it, and only if it started after the leader. A failed start stops every such member. The record is created with an exclusive link, so two concurrent starts of one service cannot both record.

### Agent identity

The starting agent is `ENG_AGENT_ID`, else `T3_THREAD_ID`. `eng run-service` and `eng stop` refuse to run without one, so an anonymous caller can never stop a service. A person running by hand sets `ENG_AGENT_ID` to their own name.

### Example: a reviewer stops a test run it did not start

On 26 Oct 2026 a reviewer thread stopped a devbox systemd test unit, `devbox-heavyweight-1792999183-707452.service`, that it had not started. Nobody could say who owned it. Under this standard the run goes through the helper instead:

```sh
# The thread that owns the test run (ENG_AGENT_ID or T3_THREAD_ID = thread-a)
eng run-service devbox-heavyweight-1792999183-707452.service
#   record: project, owner, checkout, pid, start time, boot id, run token, agent thread-a (0600)

# A reviewer thread (thread-b) in the same checkout
eng stop devbox-heavyweight-1792999183-707452.service
#   eng: FAIL stop: refusing; <project>/devbox-heavyweight-1792999183-707452.service (pid 12345) was started by thread-a,
#   not thread-b. Only the starter may stop it
eng status
#   ok  devbox-heavyweight-1792999183-707452.service pid 12345 port 41003 agent thread-a (this checkout)
```

`eng status` answers "who owns it": the record names the starting agent, and the reviewer reports to that thread instead of acting. When there is no ownership record, the helper refuses (`has no ownership record for this checkout`) and signals nothing. A target with no record is treated as someone else's, never as fair game. The same goes for a record that names another project, checkout or service, or a PID whose start time no longer matches. `test/isolation.test.mjs` replays this case with a synthetic service of exactly that name (service names may contain single dots). It is an ordinary helper-started process, not a systemd unit.

**Gap: systemd units.** The helper starts and stops only the processes it launched itself, as children in their own process group. It does not create, inspect or stop systemd units (`systemd-run`, `systemctl stop`), so a unit started outside the helper has no record, and nothing here stops a raw `systemctl stop` aimed at it. The repo check does not flag `systemctl` either. Closing this belongs to devbox-ops: have the unit launcher write the same ownership record, or label the unit with the project and starting agent, and refuse `stop` unless the caller matches. Until then, start test runs through `eng run-service` so they get a record, and treat any unit without one as not yours.

### Secrets

`.eng/secrets/<svc>.env` (for the service) and `.eng/secrets/<svc>.connect.env` (for `eng connect` clients) hold `KEY=VALUE` lines. The helper refuses a file that is a symlink, is not owned by the current user, has any group or other permission bits, is committed, or is not gitignored. `--secrets-stdin` reads the same format from stdin. Values go only into the child's environment and are never printed.

For an image whose stock entrypoint puts a secret on argv (the Convex local backend's `--instance-secret`), use a wrapper entrypoint that reads the secret from the environment or a file.

## The repo check

`eng isolation check` scans tracked and untracked, non-ignored files, except files `eng sync` generated. Add it to CI, or add `isolation` to `gates.required`.

| Rule | Files | Finds |
|------|-------|-------|
| `identity-missing`, `identity-invalid` | `.eng/project.toml` | missing file, or each schema error |
| `default-name` | package scripts, hooks, compose, shell scripts, `.env*.example` | `anonymous-agent`, and `default` where it names a project, deployment, container or compose project (`name: default`, `--project-name default`, `COMPOSE_PROJECT_NAME=default`) |
| `default-port` | package scripts, hooks, compose, shell scripts | 3210, 3211, 6791 as literals. `${VAR:-3210}` counts as an override |
| `compose-unnamed`, `compose-name` | `compose*.yml`, `docker-compose*.yml` | no top-level `name:`, or one that is not the project id or `<id>_<suffix>` (ids never contain `_`, so `alpha-beta` cannot be read as project `alpha`) |
| `bare-service-command` | package scripts, hooks | `convex <sub>` (also through npx, bunx, pnpm, yarn, or by path such as `./node_modules/.bin/convex`), `docker`, `podman`, `docker-compose` or `podman-compose` run directly instead of through `eng connect <svc> -- <listed command>` or `eng run-service` |
| `not-allowlisted` | package scripts, hooks | an `eng connect <svc> -- <cmd>` whose argv does not equal an entry on that service's `connect` list (placeholders checked by type; symlinks cannot be resolved statically) |
| `inline-code` | package scripts, hooks | inline code or a split string (`node -e`, `python -c`, `deno eval`, `sh -c`, `env -S`) |
| `shell-string` | package scripts, hooks | a line that is opaque to a static read (a shell with `-c`, quotes, `$`, backticks or backslashes) and touches docker, podman, compose, convex, kill or a secret flag: run it as argv through `eng connect` instead |
| `bare-kill` | package scripts, hooks | `kill`, `pkill`, `killall` (also by path), and docker/podman/compose `stop`, `kill`, `rm`, `down`, `restart`, `pause`, found after global options too (`docker --context x stop y`) |
| `secret-argv` | package scripts, hooks, compose, shell scripts | a flag ending in secret, password, passphrase, token, or api-, admin-, access-, private-, secret-, signing-, encryption-, master- or session-key, with a value (`--instance-secret x`, `--token=x`). Also `env NAME=value` with a secret-looking name, and both forms inside one argument (`bash -c 'client --token "$T"'`) and across a multi-line compose `command:` or `entrypoint:` list or block scalar (`>-`, `|`). The next token counts as the value even when it starts with `-`. `-file` and `--no-` flags pass |

Hooks are `.githooks/*`, `.husky/*`, `lefthook.yml` and `.pre-commit-config.yaml`. Findings print the file, line and rule, never the line's text.

```yaml
isolation:
  mode: warn    # warn: report, exit 0. fail: exit 1 on any finding.
```

`--config-from <ref>` (passed to git as an argument, never through a shell) reads the mode from that ref's `eng.config.yml`, so CI can use main's copy and a branch cannot switch itself back to warn.

## Adopting it

1. Copy `templates/isolation/project.toml` to `.eng/project.toml` (or run `eng renovate apply launch`, which seeds it and `isolation.mode: warn`). Set the owner, a unique port range and the services. Add `.eng/state/` and `.eng/secrets/` to `.gitignore`.
2. Move service secrets into `.eng/secrets/<svc>.env` (0600).
3. Route scripts and hooks through the helper: `eng run-service backend`, `eng connect backend -- npx convex codegen`, `eng stop backend`.
4. Run `eng isolation check` until it passes, then set `isolation.mode: fail`.

## Not in this release

- systemd units: no record, inspection or stop for units started outside the helper (see the example above). A devbox-ops follow-up.
- Container ownership (record container ids and `eng.project` / `eng.owner` labels). The check already requires a unique compose `name:`.
- Cross-checking the owner against the devbox-ops workspace registry. That belongs with the devbox-ops follow-up: `project-boundary` reads `.eng/project.toml` for its own ports and state and adds the ownership-record directory to its private view. The devbox-ops owner builds that piece.
- Anything that touches a running backend, moves an existing instance secret off argv, or rotates a secret. Those need Matt.
