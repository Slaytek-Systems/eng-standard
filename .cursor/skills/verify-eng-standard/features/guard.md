# Guard

`eng sync` renders a guard into `.eng/guard` and wires it into Claude Code through `.claude/settings.json`. Agent tools run it before a shell command. It denies history rewrites and skipped hooks, and stays silent (Claude Code) or allows (Cursor) everything else.

## Sub-features

- `guard-wired` `.claude/settings.json` runs `node "$CLAUDE_PROJECT_DIR/.eng/guard/hook.mjs" claude-code` on PreToolUse.
- `guard-deny-force-push` denies a forced push to `main` in Claude Code's deny format.
- `guard-silent` prints nothing for `git status` in Claude Code.
- `guard-cursor` denies `git commit --no-verify` and allows `ls` in Cursor's format, through `.eng/guard/cursor-hooks.json`.

## How to get to it (user POV)

- An agent in Claude Code or Cursor runs a shell command in the repo. The tool feeds the hook its JSON on stdin.

## Driving it with verify.sh

Preconditions:

- A repo that `eng init` set up and committed.

- **Wiring.** Read the command from `.claude/settings.json` (`hooks.PreToolUse[0].hooks[0].command`). It names `.eng/guard/hook.mjs" claude-code`.
- **Deny.** Run that command with `CLAUDE_PROJECT_DIR=<repo>` and stdin `{"tool_name":"Bash","tool_input":{"command":"<the forced push in journeys/guard.sh>"},"cwd":"<repo>"}`. Exit 0, output has `"permissionDecision":"deny"` and `force push rewrites pushed history`.
- **Silent.** Same with `git status`. Exit 0 and no output.
- **Cursor.** Run the command from `.eng/guard/cursor-hooks.json` with stdin `{"command":"git commit --no-verify -m x","cwd":"<repo>"}`. Output has `"permission":"deny"` and `--no-verify skips`. With `ls`, output has `"permission":"allow"`.
- **Journey.** `verify.sh journey <id> guard`.

## Gotchas

- The hook exits 0 whether it denies or allows. The decision is in stdout, so assert on the JSON.
- The guard fails open: a crash allows the call and prints why on stderr. A deny assertion catches that; an exit code does not.
- Codex wiring needs a `.codex/hooks.json` link that eng never makes. This journey does not drive Codex.
