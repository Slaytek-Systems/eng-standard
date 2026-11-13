# shellcheck shell=bash
# The guard eng sync wires into Claude Code (.claude/settings.json) and renders for Cursor denies a force push and
# --no-verify, and stays silent on an ordinary command. Driven as each tool runs it: the tool's hook JSON on stdin.
source "$(dirname "$0")/lib.sh"
init_repo guard
dir=$(S pwd)
expect 0 node -e "console.log(require('./.claude/settings.json').hooks.PreToolUse[0].hooks[0].command)"
has 'node "$CLAUDE_PROJECT_DIR/.eng/guard/hook.mjs" claude-code'
hook=$OUT
claude() { IN="{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"$1\"},\"cwd\":\"$dir\"}" expect 0 env CLAUDE_PROJECT_DIR="$dir" sh -c "$hook"; }
claude 'git push --force origin main'
has '"permissionDecision":"deny"'
has 'force push rewrites pushed history'
claude 'git status'
[ -z "$OUT" ] || { echo "JOURNEY FAIL: the guard printed a decision for git status"; exit 1; }
echo 'ok: no decision for git status'
expect 0 node -e "console.log(require('./.eng/guard/cursor-hooks.json').hooks.beforeShellExecution[0].command)"
has 'node .eng/guard/hook.mjs cursor'
hook=$OUT
IN="{\"command\":\"git commit --no-verify -m x\",\"cwd\":\"$dir\"}" expect 0 sh -c "$hook"
has '"permission":"deny"'
has '--no-verify skips'
IN="{\"command\":\"ls\",\"cwd\":\"$dir\"}" expect 0 sh -c "$hook"
has '"permission":"allow"'
