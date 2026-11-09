# Living with eng-standard: pin, keep current, upgrade, uninstall

This is the one guide to eng-standard in a repo. Every rendered `AGENTS.md` points here (section "This standard"), and
the package ships this file, so an agent finds it at `node_modules/@slayteksystems/eng-standard/docs/lifecycle.md` or at
https://github.com/Slaytek-Systems/eng-standard/blob/main/docs/lifecycle.md.

## Where things live

| You need | Read |
|---|---|
| The rules for this repo, day to day | the rendered `AGENTS.md` block, then `SHIPPING.md`, then `STACK.md` |
| Every `eng` command | `eng --help`, then the [README](../README.md) table. There are ten. `eng <command> --help` (or `-h`) prints one command's usage and runs nothing |
| What changed between versions | [CHANGELOG.md](../CHANGELOG.md), also shipped in the package |
| Every setting | `eng.config.yml`; the reference with a comment on each key is `templates/eng.config.yml` |
| A repo that already ships | [renovation/README.md](../renovation/README.md) |

## Pin

The package is not on npm. A repo installs it from GitHub as a dev dependency pinned to a release tag:

```json
"devDependencies": {
  "@slayteksystems/eng-standard": "github:Slaytek-Systems/eng-standard#vX.Y.Z"
}
```

- Pin a `vX.Y.Z` tag. From 0.15.0, the `release-tag` job in eng-standard's `ci.yml` tags the `main` commit that changed
  `package.json` to X.Y.Z once its `test` passes. A tag is never moved or deleted. The latest tag is
  `gh api repos/Slaytek-Systems/eng-standard/tags -q '.[0].name'`.
- Releases 0.9.1 to 0.14.0 have no tag. A repo on one of them pins its full commit SHA until it upgrades.
- A full commit SHA is also fixed. A branch (`#main`), a short SHA, a range or a git URL with no `#` floats: the
  standard would change under the repo with no commit in it. `eng sync --check` fails a floating pin.
- Run the CLI as `npx --no-install eng`, `bunx eng` or `node node_modules/@slayteksystems/eng-standard/bin/eng.mjs`.
  The pre-commit hook reads `$ENG` for the same choice.

## Keep it current

| Check | Fails when | Where it runs |
|---|---|---|
| `eng sync --check` | a generated file or lock path differs from what `eng.config.yml` renders; `.eng/lock.json` was rendered by another eng version than the installed one or names no valid version; the pin floats; the config has entries this release retired or lacks `git.rewrite_pushed`. Each failure names its fix | `.githooks/pre-commit`, CI, the gate where listed |
| `eng doctor` | a config piece, an enforcer, the merge settings or a disk rule is wrong; the lock is stale or the pin floats. It also prints the `git.rewrite_pushed` mode and the installed, rendered and latest versions | on demand; the gate where listed |

`eng doctor` reads the latest version and CHANGELOG from eng-standard `main` on GitHub, or from `ENG_STANDARD_SOURCE`
(an eng-standard checkout or a base URL). Behind is a `WARN` with the CHANGELOG entries in between, not a failure: an
upgrade is a choice. If it cannot read the latest version, it says `latest UNKNOWN` and why. It never prints that as
current.

## Upgrade

1. `eng doctor`. Read every CHANGELOG entry it lists. Entries marked **Breaking** or risk:high change gates, CI or
   permissions.
2. On a branch, move the pin to the new `vX.Y.Z` tag and install with the repo's package manager.
3. `eng sync`. It rewrites the generated files and `.eng/lock.json`, and migrates retired config entries in place
   (it prints each one). From 0.15.0 it also adds `git.rewrite_pushed` when the config lacks it: `protected` when the
   checkout has `.git/.graphite_repo_config` (with a comment that `never` is recommended), otherwise `never`. It prints
   which and why. Review the diff. From 0.18.0 a config with no `profile` line renders the generic text and sync prints
   one line about it: add `profile: slaytek` to keep Slaytek Systems' rules exactly as before, or `profile: generic`
   to hide the line (README, Profiles). Sync never adds it for you.
4. `eng sync --check`, then `eng gate`.
5. One PR, titled `eng-standard X.Y.Z`. It goes through the repo's own gates and verification like any PR.

## Set up

`eng init` is the one contextual init (Matt, 6 Nov 2026). Add the pinned dependency first.

- An empty repo gets the starter `eng.config.yml`. Edit `project.name` and `merge`, then `eng sync`.
- A repo that already ships needs `eng init --owner @handle`. It seeds a config from what is there and writes
  baselines, so findings it has today pass and only new ones fail. Details: [renovation/README.md](../renovation/README.md).
- Either way it renders every generated file, sets `core.hooksPath .githooks`, and prints the branch ruleset to apply by
  hand. eng never edits rulesets.
- Skills render into `agents.skills_dir` (`.agents/skills`), subagents into the folder beside it (`.agents/agents`). The
  rendered `AGENTS.md` tells every agent to read `.agents/skills/<name>/SKILL.md` directly. eng never creates, changes or
  deletes anything in `.claude/skills` or `.claude/agents`: developers and other tools own those folders. A
  setting that would make eng write into either one (`agents.skills_dir: .claude/skills` or `.claude/custom`,
  `verification.checks_dir: .claude/skills`) is a config error, and an old lock's files there are never pruned. For Claude Code's own skill discovery, link each folder once:
  `ln -s ../.agents/skills .claude/skills` and `ln -s ../.agents/agents .claude/agents`. `eng sync` and `eng doctor`
  print one line saying whether Claude Code can see every eng skill and subagent there, and the fix when it cannot,
  quoted and relative to the real `.claude` folder when `.claude` is itself a link. It is a warning, never a failure.

## Joining agent

1. Read the rendered `AGENTS.md` block in full, then `SHIPPING.md`. Claude Code gets the same text through `CLAUDE.md`
   (`@AGENTS.md`). Codex reads `AGENTS.md` directly.
2. Put `Agent:` and `Agent-Family:` trailers on every commit.
3. Run `eng gate` before you ask for review. Never merge your own PR.
4. Read `git.rewrite_pushed` in `eng.config.yml` (SHIPPING.md rule 1 says the same).
   - `never` (the default and the recommendation). Pushed history is never rewritten. Tidy commits only before their
     first push. After a push, every follow-up is a new commit, and the base comes in by merge
     (`gh pr update-branch <n>`). The pre-push hook refuses a non-fast-forward push to any branch, and the pre-rebase
     hook refuses a rebase that would rewrite pushed commits.
   - `protected`. The default branch, `project.protected_branches` and tags are locked. A pushed feature branch may be
     rewritten only through the repo's guarded tool, for example Graphite's `gt restack` and lease-protected `gt submit`.
   - In both modes a pushed tag never moves, a protected branch is never deleted or rewritten, and the Claude Code deny
     list blocks a raw forced push wherever the flag or `+` refspec sits on the line. In `protected` mode that deny list is
     the only agent-side guard for feature branches: the pre-push hook cannot tell a raw forced push from `gt submit`.
     Only Claude Code gets a deny list (`.claude/settings.json`). Other harnesses in `agents.harnesses` (codex, cursor)
     get the git hooks and the rendered text; the rendered rules and `eng doctor` name each one's gaps.
5. Never hand-edit a generated file. Edit `eng.config.yml` and run `eng sync`.

## Git hooks

`eng sync` renders `.githooks/pre-commit`, `.githooks/pre-push` and `.githooks/pre-rebase`. `eng init` points
`core.hooksPath` at `.githooks`. That setting is shared by every worktree of a clone, so a repo keeps its own hook rules
as commands in `eng.config.yml`, not in another hooks directory.

- `hooks.pre_commit`. `.githooks/pre-commit` runs `eng sync --check` and `eng lint`, then each command in its own
  `sh -c`, in order. It stops at the first failure.
- `hooks.pre_push` (0.17.0). `.githooks/pre-push` runs eng's push checks first, unchanged (`git.rewrite_pushed`). When
  they refuse, the push fails and no command runs. Then it runs each command in its own `sh -c`, in order, with the
  hook's arguments (`$1` the remote name, `$2` its URL) and the same ref lines on stdin that git gave the hook, byte for
  byte, an empty stdin included. Inside the command they are `$1` and `$2`, so a script gets them only when the command
  passes them on: `scripts/check-push.sh "$@"`. `eng doctor` warns when a repo script is listed without them. The push fails at the first command that exits non-zero. The hook prints
  `eng: hooks.pre_push command <i> of <n> failed (exit <code>): <command>` and exits with that code. The hook runs
  from the top of the work tree, so `scripts/check-push.sh` names a file in the repo.
- A command can refuse more pushes. It cannot let through a push that eng's checks refuse, because they run first.
- `eng doctor` fails when a command in either list starts with a repo-relative path (`scripts/x.sh`, `./bin/check`)
  that is missing or not executable.
- `git push --no-verify` and `git commit --no-verify` skip the whole hook, eng's checks and the repo's commands alike.
  This is git's behaviour and eng does not change it. The Claude Code deny list blocks the common forms for agents, and
  a server ruleset is the real wall for protected branches.

Example. A repo that refuses new refs and fast-forwards to its release branches moves those rules into a script:

```yaml
hooks:
  pre_push: ['scripts/git-hooks/branch-classes.sh "$@"']
```

## Uninstall

There is no uninstall command. These steps remove what `eng sync` manages and keep anything edited by hand. Do it in one
PR.

1. `eng sync --check`. A file it reports as differing from the render was edited by hand. Keep it, or move the edits
   somewhere else first.
2. List what eng manages: `node -p "require('./.eng/lock.json').files.join('\n')"`. Links in `.claude/skills` or
   `.claude/agents` are yours: eng before 0.17.2 made per-skill links there, and none is listed.
3. `git rm` each listed path except the hand-edited ones and `AGENTS.md`. In `AGENTS.md`, delete only the lines from
   `<!-- eng:begin -->` to `<!-- eng:end -->`. Your own text stays. Keep `CLAUDE.md` if `AGENTS.md` still has text.
4. `git rm .eng/lock.json`, then `git config --unset core.hooksPath`.
5. By hand: remove the `@slayteksystems/eng-standard` dependency, the CI steps that call `eng`, and eng's required checks
   from the branch ruleset.
6. `eng.config.yml`, `.eng/checks`, `.eng/evidence` and `renovation/baselines` are yours to keep or delete.

## Report a problem with the standard

A wrong rule, a command that fails because of the standard, or a doc that disagrees with the code: open an issue at
https://github.com/Slaytek-Systems/eng-standard/issues with the repo, the `eng doctor` output and the failing command's
output. Fix it upstream in eng-standard, never by editing generated files in the repo.

## How eng-standard checks its own docs

`npm test` (the `test` check on every PR) runs:

- `test/docs.test.mjs`. It fails when `package.json`, `package-lock.json` and the newest CHANGELOG version disagree,
  when `eng --help` or the README table lists anything other than the ten hallway commands, when a doc, template or
  rendered file names an `eng <command>` that does not exist, when a relative link is broken, when a doc is not shipped
  in the package, or when a file still names the old repo owner.
- `test/no-force-push.test.mjs`. It fails when a doc, template or rendered file, vendored skills included, tells an
  agent to rewrite pushed history with a forced push. It reads tracked and untracked files, so a new doc counts before
  its first commit. Upstream pstack sentences that say otherwise are rewritten at install time through
  `vendor/pstack/REWRITES.tsv`; the vendored copy stays byte-identical.
- `test/rewrite-mode.test.mjs`. It drives the rendered pre-push and pre-rebase hooks against a bare remote in both
  `git.rewrite_pushed` modes, and proves the `eng sync` migration, `eng init` and the config error.
- `test/pre-push.test.mjs`. It pushes for real to a bare remote through the rendered `.githooks/pre-push`, 144 rows:
  six ref shapes, three targets, four `hooks.pre_push` commands (none, Kalsigns-shaped, passing, failing) and both
  `git.rewrite_pushed` modes. It checks each outcome, the arguments and stdin each command saw, that eng refuses first,
  and that `--no-verify` skips the hook. It also proves the Kalsigns-shaped 12 refusals and that a config without the key
  renders the 0.16.2 hook byte for byte.
- `test/standard.test.mjs`. It proves the rendered "This standard" section, the `sync --check` pin and lock checks, and
  the `eng doctor` version lines in a scratch repo.
- `test/release.test.mjs`. It covers the release-tag rule and the `release-tag` job in `ci.yml`.
