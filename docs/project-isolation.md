# Devbox project isolation (v0.11.0, warn only)

Every project on the devbox runs as one Unix user (`dev`) with one home folder. Shared defaults, such as Convex's `anonymous-agent` state in `~/.convex` and the default port 3210, let one project's tool reach another project's service. On 24 Oct 2026 a commit hook in one project ran codegen against another project's backend. On 25 Oct a reviewer killed another project's test run.

This standard gives each repo three things: an identity file, a helper that starts and stops services only with proof of ownership, and a repo check. The check warns by default. One config switch makes it fail.

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

[[services]]
name = "backend"
command = ["./scripts/backend.sh", "--port", "{port}", "--data", "{state}/data"]
port_env = "PORT"         # optional: env var that also carries the port
health = "/version"       # optional: HTTP path on 127.0.0.1:<port>
ready_timeout_s = 30      # optional, default 30
env = { LOG_LEVEL = "info" }                               # optional, non-secret
connect_env = { BACKEND_URL = "http://127.0.0.1:{port}" }  # optional, for eng connect
```

`command` is argv, run without a shell. `{port}` and `{state}` are filled in. The parser takes a TOML subset: tables, `[[services]]`, strings, integers, booleans, and arrays and inline tables on one line. It rejects anything else with the line number.

Validation fails on: a missing or default id or owner, a missing state path, a state path that starts with `/`, `~` or `$` or contains `..`, a port range outside 1024 to 65535 or containing a default port, an unnamed, duplicate or default-named service, a secret flag in `command`, and a secret-looking key (`*SECRET*`, `*TOKEN*`, `*PASSWORD*`, `*API_KEY*`, `*ADMIN_KEY*`, ...) in `env` or `connect_env`, and any key eng sets itself (`HOME`, `PATH`, `ENG_STATE`, `ENG_PORT`, `ENG_PROJECT`, `ENG_SERVICE`, `ENG_SERVICE_URL`, `ENG_SERVICE_PORT`, `ENG_RUN_TOKEN`, the service's `port_env`). `port_env` itself may not name one of those keys. Secrets files may not set those keys either, and eng sets them last.

## The helper

All four commands run from the checkout root and read `.eng/project.toml`. They need Linux `/proc`.

| Command | Does |
|---------|------|
| `eng run-service <svc> [--secrets-stdin]` | Picks the first free port in `project.ports`, makes `<state>/<svc>` (0700) and uses it as `HOME`, scrubs inherited `CONVEX_*`, loads secrets, starts the command in its own process group, writes the ownership record, then waits until the process is still the same one and the health path answers 2xx. The state path may not contain a symlink and must resolve inside the checkout. The ownership directory is created before the service starts, and any failure after the start stops the service. Output goes to `<state>/<svc>/service.log` (0600) only when no secrets were loaded; otherwise it is discarded, because raw output can echo a secret |
| `eng connect <svc> -- <cmd...>` | Checks the record and health, runs the command with `ENG_SERVICE_URL`, `ENG_SERVICE_PORT`, `connect_env` and `.eng/secrets/<svc>.connect.env`, with `CONVEX_*` scrubbed. Then checks the record and health again and reports the target it touched. Exits with the command's code, or 1 when the target changed |
| `eng stop <svc>` | Refuses unless the record is for this service, project, owner and checkout, and the caller started it. Sends SIGTERM to the recorded process and every member of its process group that carries the run's `ENG_RUN_TOKEN` (so children that outlive the leader are stopped too), waits up to 10 s, then SIGKILL. Verifies they are gone and removes the record. A record with no matching process left is removed without sending any signal |
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
| `compose-unnamed`, `compose-name` | `compose*.yml`, `docker-compose*.yml` | no top-level `name:`, or one without the project id |
| `bare-service-command` | package scripts, hooks | `convex <sub>` (also through npx, bunx, pnpm, yarn), `docker compose`, `podman compose`, unless that command (split on `&&`, `||`, `;`, `|`) is itself an `eng connect` or `eng run-service` invocation |
| `bare-kill` | package scripts, hooks | `kill`, `pkill`, `killall`, `docker`/`podman` `stop`, `kill`, `rm` |
| `secret-argv` | package scripts, hooks, compose, shell scripts | a flag ending in secret, password, token, api-key, admin-key, access-key or private-key, with a value (`--instance-secret x`, `--token=x`). Also `env NAME=value` with a secret-looking name, and both forms inside one argument (`bash -c 'client --token "$T"'`) and across a multi-line compose `command:` or `entrypoint:` list. `-file` and `--no-` flags pass |

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

- Container ownership (record container ids and `eng.project` / `eng.owner` labels). The check already requires a unique compose `name:`.
- Cross-checking the owner against the devbox-ops workspace registry. That belongs with the devbox-ops follow-up: `project-boundary` reads `.eng/project.toml` for its own ports and state and adds the ownership-record directory to its private view. The devbox-ops owner builds that piece.
- Anything that touches a running backend, moves an existing instance secret off argv, or rotates a secret. Those need Matt.
