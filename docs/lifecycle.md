# Living with eng-standard: pin, keep current, upgrade, uninstall

This is the one guide to eng-standard in a repo. Every rendered `SHIPPING.md` points here (Reference, section "This standard"), and
the package ships this file, so an agent finds it at `node_modules/@slayteksystems/eng-standard/docs/lifecycle.md` or at
https://github.com/Slaytek-Systems/eng-standard/blob/main/docs/lifecycle.md.

## Where things live

| You need | Read |
|---|---|
| The rules for this repo, day to day | the rendered `AGENTS.md` block (three lines), then `SHIPPING.md` (its Reference section holds the commands, checks, skill router and rule-to-enforcer table), then `STACK.md` |
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

### Lowering a gate

A repo may lower any merge gate, in any PR, including the PR that changes it. eng never blocks that. A lowering is
never silent:

- For a repo set up from 0.18.2 on, the template's `ship.high_risk.paths` include `eng.config.yml` and
  `.eng/checks/**`, so a change to gate settings is risk:high and needs the repo owner. Older configs keep their own
  paths until the owner adds these two; `eng doctor` lists them as missing.
- A change to the `ship.high_risk` block itself (its paths, verifiers or label) is risk:high in every repo, whatever
  the new block says, so a PR cannot take itself out of risk:high. `lib/risk.mjs` compares the block at the base and
  the head only to see the change; it applies the head's levels. `eng verdict check` prints a line saying so, and the
  risk label and self-merge use the same classifier.
- `eng doctor` prints "Gates below the standard default". Each line names the setting, the repo's value, the standard
  default (what `templates/eng.config.yml` sets, else the code's fallback) and the config line that restores it. It is
  information only and never changes doctor's exit code. A supported lowering, such as a disk rule or `ephemeral_runs`
  at `mode: off` or `hygiene.tmp_lint: false`, is a row here, not a doctor failure; an invalid value still fails. The
  settings it compares are one table in `lib/gate-levels.mjs`; the 0.18.2 CHANGELOG entry lists them.
- Below that, "Other gate settings changed from the standard (direction not judged)" lists every other setting the
  repo sets in a gate block (`gates`, `renovation.gates`, `verification`, `ship`, `merge`, `hygiene`, `laws`, `flags`,
  `db`, `e2e`, `constraints`) to something other than the standard for its profile, with both values. It does not say
  whether the change lowers anything, and it never changes doctor's exit code either.
- `eng lint` uses the PR's own config, so a lowering applies in the PR that makes it. `eng merge gate` does not: every
  `merge.auto` setting and `verification.review_only_paths` come from the trusted checkout (main, or the queue's base
  commit), so a PR cannot relax the gate that decides its own merge. It prints a note when the PR changes them, and the
  change applies to the next PR after it merges. An unreadable or invalid trusted config fails the gate. In a merge_group
  the base's config gets main's checks and must be a regular file. `base_sha` must be a commit strictly behind the queued
  commit; a missing one, the queued commit itself, an unrelated commit or a tree fails the gate. `high_risk_paths` entries
  must be non-blank strings; a well-formed glob that matches nothing is allowed, because the trusted config sets policy.

## Upgrade

From 0.20.0, every eng command except `eng doctor` prints one line on stderr when a newer release exists, with the
install command for the repo's package manager and pin, for example
`eng: eng-standard 0.20.0 is available (this repo runs 0.19.1). To update: npm install -D "@slayteksystems/eng-standard@github:Slaytek-Systems/eng-standard#v0.20.0", then eng sync and eng gate, and commit it all in one PR.`
It reads the latest version from eng-standard main (or `ENG_STANDARD_SOURCE`) at most once a day per machine, caches it
under `$XDG_CACHE_HOME/eng/latest-version.json`, and prints nothing when offline. The read runs in a child process that is killed, and ends itself, at 2 seconds, so a slow,
unreachable or misbehaving network adds at most 2 seconds, once. A plain version pin is kept exact (`--save-exact` or `--exact`). It never changes a command's output
or exit code. It is off in CI (`CI` set), under `node --test`, in a repo that does not pin the package, and with
`ENG_NO_UPDATE_CHECK=1`.

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
  `ln -s ../.agents/skills .claude/skills` and `ln -s ../.agents/agents .claude/agents`. `eng sync` prints one line
  saying whether Claude Code can see every eng skill and subagent there, and the fix when it cannot, quoted and
  relative to the real `.claude` folder when `.claude` is itself a link. It is a warning, never a failure.
- No agent tool standard says where skills live, and many developers link every tool's folder to one central folder.
  So eng never creates or changes a link. `eng doctor` prints a Skills section instead: whether `.agents`, `.claude`,
  `.claude/skills` and `.claude/agents` are absent, a folder or a link (and where it points), and how many of eng's
  skills Codex, Cursor and Claude Code each see at their repo folders. Codex reads `.agents/skills`. Cursor reads
  `.agents/skills`, `.cursor/skills`, `.claude/skills` and `.codex/skills`. Claude Code reads `.claude/skills` and,
  for subagents, `.claude/agents`. When a tool misses some, it prints the links that fix it, or says to install eng's
  skills into each tool's own folder. A tool not in `agents.harnesses` is marked `info`, not `WARN`. Skills in the
  home folder (`~/.agents/skills`, `~/.claude/skills` and the like) are not checked. The section never changes
  doctor's exit code.

## Joining agent

1. Read the rendered `AGENTS.md` block, then `SHIPPING.md`. Claude Code gets the same text through `CLAUDE.md`
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
     get the git hooks and the rendered text; the rendered rules and `eng doctor` name each one's gaps. The guard (below)
     blocks a forced push before the command runs in every tool where its hook is wired.
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

## Guard

From 0.21.0, `eng sync` renders a small repo-level guard into `.eng/guard`. Before a command runs, it blocks only what
damages this repo's history or work, and each block names the allowed route. Nothing else is blocked.

Every block names its route. The destructive git forms are one table, `DESTRUCTIVE` in `lib/guard.mjs`; a test keeps
this copy in step with it. Any shape: denied wherever the form appears. Alone at the root: the form depends on the
repo's state, so it is checked only when it is the whole command run from the repo root (below), and denied there when
it would lose work; in any other shape it is denied. git accepts any unique prefix of a long option, so the guard
counts any prefix as the option (`--har` is `--hard`, `--del --forc` is `--delete --force`); a prefix two options share
counts as either, and git refuses it anyway. A flag that makes a form safe (`-n`, `--cached`, `--staged`, `--detach`,
`--orphan`) is read as git reads it: the last word wins, and `--no-<name>` or a prefix of it turns the flag off again.
Untracked files count only for the forms that can overwrite them, and ignored files never count: stash them with
`git stash push --include-untracked`.

| Destructive git form | Denied | Route the message names |
|---|---|---|
| a forced `git push`: a force flag (`-f` and any `--force` form, the lease forms included), `--mirror` or a `+` refspec | any shape, in both `git.rewrite_pushed` modes | add a commit; bring in the base by merge (`gh pr update-branch <n>`); in `protected` mode, rewrite a feature branch only through the guarded tool (`gt submit`) |
| `git push` deleting a protected branch (`--delete`, `-d` or `:branch`) | any shape | delete only your own feature branches; to change a protected branch, open a pull request |
| `git push --prune` | any shape | delete only your own feature branches, by name |
| `--no-verify` on any git command but the read-only ones, and `git commit -n` | any shape | run it without the flag and fix what the hook reports |
| `git -c core.hooksPath=<path>` or `--config-env core.hooksPath=<var>`, any path but `.githooks` | any shape | keep `.githooks`; add a check through `hooks.pre_commit` or `hooks.pre_push` |
| `git config` setting or unsetting `core.hooksPath`, any path but `.githooks` | any shape | the same |
| `git worktree remove --force` | any shape | commit or stash first, or remove the worktree without `--force` and report what git says |
| `git clean` without `-n` or `--dry-run` (a later `--no-dry-run` turns it off) | any shape | list with `git clean -n` and remove your own files by name |
| `git stash drop`, `git stash clear` | any shape | leave the entries; apply yours by SHA |
| `git update-ref`, any form | any shape | move a branch with `git branch -f` alone at the root; delete one with `git branch -d` |
| a forced `git fetch` or `git pull` into a local ref (`+<src>:<dst>`, or `<src>:<dst>` with `-f`, `--force` or `--refmap`), `<dst>` not under `refs/remotes/` or `refs/tags/` | any shape | fetch into the remote-tracking branches, then `git branch -f <branch> origin/<branch>` alone at the root |
| `git reset --hard` (untracked files count), `--merge` or `--keep` | alone at the root when tracked files have uncommitted changes, or for `--hard` when there is any untracked file; any other shape | commit or stash first (`git stash push --include-untracked`) |
| `git checkout -f` or `--force` (untracked files count), and `git checkout` with paths (`-- <paths>`, `<commit> <paths>`, or one word that may be a path; untracked files under the paths count when a commit is given) | alone at the root when those paths (the whole tree for `-f`) have uncommitted changes or the untracked files that count; any other shape | commit or stash first; to change branch inside a chain, `git switch <branch>` |
| `git switch -f`, `--force` or `--discard-changes` (untracked files count) | alone at the root when tracked files have uncommitted changes or there is any untracked file; any other shape | commit or stash first |
| `git restore <paths>`, except `--staged` alone (untracked files under the paths count with `--source`) | alone at the root when those paths have uncommitted changes or the untracked files that count; any other shape | commit or stash first |
| `git rm -f` or `--force`, except with `--cached` (a later `--no-cached` turns it off) | alone at the root when those paths have uncommitted changes; any other shape | commit or stash first |
| `git branch -D`, `-d -f` or `--delete --force` | alone at the root when the branch's tip is on neither its upstream nor the default branch; any other shape | push it first, or use `git branch -d` |
| `git branch -f` or `--force` onto an existing branch, and `-M`, `-C`, or `-m` or `-c` with `-f`, onto one | alone at the root when the branch it replaces has a tip on neither its upstream nor the default branch; any other shape | push it first, or use a new branch name |
| `git switch -C` or `--force-create` onto an existing branch | the same | the same |
| `git checkout -B` onto an existing branch | the same | the same |
| `git worktree add -B` onto an existing branch | the same | the same |

| Other blocks | Route the message names |
|---|---|
| `gh pr merge --admin` | let the repo's merge rule merge it |
| Editing the guard: Edit or Write on `.eng/guard`, on an eng-rendered `.claude/settings.json`, or one that removes eng's entry from a tool's hook file; shell commands that remove, move or overwrite those files | change `eng.config.yml` and run `eng sync` |
| A construct the parser does not model, in a command that mentions git (below) | run the git command as its own command, with literal words |

- **Wiring.** eng treats tool hook files like skill folders: it never writes into `.codex` or `.cursor`. It renders
  `.eng/guard/codex-hooks.json` and `.eng/guard/cursor-hooks.json`, and `eng doctor` prints a Guard section with one
  row per tool. When the tool has no hook file, the row gives the `ln -s` that wires it (relative, quoted, with
  `mkdir -p` when needed). When the tool has its own file, it gives the exact entry to add. Claude Code is the
  exception: `.claude/settings.json` is a file eng renders in full, so its PreToolUse hook goes there whenever
  `claude-code` is in `agents.harnesses`. The section never changes doctor's exit code.
- **Trust.** Codex runs a repo hook only in a trusted project and only after you trust that hook once in `/hooks`; an
  untrusted one does not run, and `codex exec` says nothing about it (checked on codex-cli 0.167.1). Cursor runs project
  hooks only in a trusted workspace. eng cannot see either setting.
- **Fails open.** The guard uses only Node built-ins, writes nothing, asks git read-only questions with optional locks
  off, and allows the command when it hits its own error (a note goes to stderr). A guard bug never blocks work.
- **Cursor allow.** The guard answers Cursor with `{"permission":"allow"}` when it does not deny. Cursor enforces only
  `deny` today (Cursor staff, forum.cursor.com/t/155711/4, 26 Mar 2026), so this skips no approval prompt. If Cursor
  starts to honour `allow`, the guard should answer `ask` instead (a comment in `lib/guard-hook.mjs` says so).
- **Fail closed by structure** (0.21.0, sixth verify round). Five rounds closed one parser gap at a time, and each
  round found the next. Now the parser models only quotes, backslashes and line continuations, `&&`, `||`, `;`, `|`,
  `&`, newlines, `( )`, `{ }`, `$( )`, backticks, heredocs, env prefixes, the usual wrappers (`sudo`, `env` and
  `env -S`, `command`, `nice`, `timeout`, `xargs` and the like), `sh -c` or `bash -c` with one option word (`-c`,
  `-lc`, `-ec`), `find -exec` and git's global options. Anything else is a construct it does not model: `$'...'` and
  `$"..."` quoting, `<( )` and `>( )`, `${...}` beyond `${NAME}`, a backslash inside backticks, an unterminated quote,
  `eval`, `exec`, `trap`, `alias`, `case`, `select`, `coproc`, a nested shell with any other option (`bash -o pipefail
  -c`, `bash +e -c`) or reading stdin (`... | bash`, `bash <<EOF`), other shells (`fish`, `csh`, `pwsh`), and `env -S`
  with escapes or variables. When the command text mentions git (or gh, or a guard file) and uses any of them, it is
  denied with the route: run the git command as its own command, with literal words. The verb-aware rules then apply
  only to commands the parser fully models, so read-only git keeps working in any shape, chains included. Inside those,
  a word the guard cannot know (a variable, substitution, glob, brace expansion, `xargs` input or `find`'s `{}`) in a
  git subcommand that has a destructive form or runs hooks (`push`, `commit`, `merge`, `rebase`, `pull`, `am`, `reset`,
  `checkout`, `switch`, `restore`, `rm`, `clean`, `branch`, `stash`, `worktree`, `update-ref`, `config`) is denied the
  same way. So `git push origin "$(git branch --show-current)"` is denied: use `git push origin HEAD`. A word inside
  double quotes that is an option's value stays allowed (`git commit -m "$(cat <<'EOF' ...)"`). Read-only subcommands
  (`log`, `show`, `diff`, `status`, `grep` and the like) take any words. A command name made from a variable or
  substitution, given a git subcommand (`$g reset --hard`), is read as git. A value git runs as a command that runs git
  (`-c alias.*`, a `-c` value, or `GIT_PAGER`, `GIT_EDITOR` or `GIT_SSH_COMMAND`) is denied. A program given `git` as
  a separate word (`strace git ...`, `watch git ...`, `eng run -- git ...`) is read as running that git command, so it
  is never alone. `echo`, `printf`, `grep` and the like only print or search, so a git word there is data.
- **Not covered.** File edits in Codex and Cursor (their hooks see shell commands only). Aliases and functions defined
  in an earlier command (`git config alias.x ...`, then `git x`), scripts and files a command runs (`bash x.sh`,
  `source x`, `make`), programs that run a command from a quoted string (`ssh host '...'`, `watch '...'`, `su -c '...'`),
  and anything outside this repo. A redirect is checked on every command, `cd` and the other builtins included
  (`cd . > .eng/guard/hook.mjs` truncates the file before `cd` runs). A nested shell inherits the env assignments
  before it.
- **Destructive git runs only alone from the repo root** (Matt, 12 Nov 2026, option b). The guard does not follow
  folders. The forms marked "alone at the root" in the table are checked against the repo's state only when the command
  is the whole command: one simple command that starts with `git`, with no `-C`, `--git-dir` or `--work-tree`, no env
  assignment or wrapper before it (`env -C`, `sudo -D`, `command`, `time`), not in a subshell, `{ }` group,
  substitution, `sh -c` or `find -exec`, no `;`, `&&`, `||`, `|`, `&` or newline before or after it, and no heredoc.
  It must also run from the repo root: the folder the tool reports is the root git reports (`git rev-parse
  --show-toplevel`, symlinks resolved). In any other shape, and when the guard cannot find the root, it denies them
  even in a clean repo, with the route: run it alone from the repo root, and commit or stash first. So
  `cd sub && git reset --hard`, `git -C sub reset --hard` and `git reset --hard` run from a subfolder are all denied;
  move to the root in a command of its own, then run it. A plain redirect such as `2>&1` is allowed. When the guard
  cannot read the repo's state (git fails), it denies those commands too. `git checkout <branch>` is a form with one
  word that may be a path, so in a chain it is denied; `git switch <branch>` never discards changes and works in any
  shape. `git status`, `git diff`, `git add` and the forms that do not depend on the repo's state work in any shape.
  The guard is a seat belt for agents; the git hooks, the server ruleset and CI stay the wall.
- **Shell writes after a folder change.** A shell write (`rm`, `mv`, `cp`, `tee`, `sed -i`, a `>` redirect and the
  like) is checked against the folder the tool reports, unless the script may change folders (`cd`, `pushd`, `popd`,
  `source`, `eval`, a function, `alias`, `trap`, `shopt`, a `CDPATH`, `GIT_DIR` or `GIT_WORK_TREE` setting, `env -C`,
  `sudo -D`, `find -execdir`, `git -C`). Then the guard cannot tell where a relative path points, so it denies a
  target whose path uses any of these names: `.eng`, `guard`, `.claude`, `.codex`, `.cursor`, `hook.mjs`, `guard.mjs`,
  `config.json`, `codex-hooks.json`, `cursor-hooks.json`, `settings.json`, `hooks.json`, or a path made only of `..`.
  So `cd sub && rm config.json` and `cd docs && echo hi > hooks.json` are denied although neither is a guard file. Run
  the write from the repo root with the path from there (`rm sub/config.json`), which is checked against the real
  guard files and allowed.
- **Off.** `guard: off` in `eng.config.yml`, then `eng sync`, removes `.eng/guard` (the folder too) and the Claude Code
  hook. eng never writes into `.codex` or `.cursor`, so a link or entry you added there stays: `eng doctor` names each
  one that still points at the removed guard, with the `rm` or the entry to delete. It lists the guard under "Gates
  below the standard default". Any other value is a config error.

## Uninstall

There is no uninstall command. These steps remove what `eng sync` manages and keep anything edited by hand. Do it in one
PR.

1. Set `guard: off` in `eng.config.yml` and run `eng sync`. The guard blocks removing its own files and unsetting
   `core.hooksPath`, which the steps below do. Then `eng sync --check`. A file it reports as differing from the render
   was edited by hand. Keep it, or move the edits somewhere else first.
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
