// The guard's hook entry point. eng sync copies this file unchanged into .eng/guard/hook.mjs, beside guard.mjs and
// config.json. Each tool runs `node .eng/guard/hook.mjs <tool>` before a shell command (and, in Claude Code, before an
// Edit or Write). It reads the tool's JSON on stdin, asks the policy, and prints the tool's own deny format.
// Node built-ins only, writes nothing, and fails open: on its own error it allows the call and says why on stderr, so a
// guard bug never blocks work. git is asked read-only questions with optional locks off.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Per tool: the request from its stdin JSON, and what to print to deny or allow (checked 11 Nov 2026).
// Claude Code (code.claude.com/docs/en/hooks) and Codex (codex-cli 0.167.1, run for real): PreToolUse, deny with
// hookSpecificOutput.permissionDecision; nothing on stdout means no decision. Cursor (cursor.com/docs/hooks):
// beforeShellExecution, { permission, user_message, agent_message }; it documents no "no decision" output, so allow is explicit.
const preToolUse = input => {
  const t = input.tool_input ?? {}, cwd = input.cwd || process.cwd();
  const command = Array.isArray(t.command) ? shellArgv(t.command) : t.command;
  switch (input.tool_name) {
    case 'Bash': case 'shell': case 'exec_command': return { tool: 'bash', command, cwd };
    case 'Edit': return { tool: 'edit', path: t.file_path, old: t.old_string, new: t.new_string, cwd };
    case 'MultiEdit': return { tool: 'edit', path: t.file_path, old: (t.edits ?? []).map(e => e.old_string).join('\n'), new: (t.edits ?? []).map(e => e.new_string).join('\n'), cwd };
    case 'Write': return { tool: 'write', path: t.file_path, content: t.content, cwd };
    default: return null;
  }
};
const claudeDeny = reason => JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
const TOOLS = {
  'claude-code': { request: preToolUse, deny: claudeDeny, allow: '' },
  codex: { request: preToolUse, deny: claudeDeny, allow: '' },
  cursor: {
    request: input => ({ tool: 'bash', command: input.command, cwd: input.cwd || input.workspace_roots?.[0] || process.cwd() }),
    deny: reason => JSON.stringify({ permission: 'deny', user_message: reason, agent_message: reason }),
    // Cursor enforces only deny today (staff, forum.cursor.com/t/155711/4, 26 Mar 2026), so allow widens nothing. If Cursor
    // starts to honour allow, it would skip the user's approval prompt: switch this to { permission: 'ask' } then.
    allow: JSON.stringify({ permission: 'allow' }),
  },
};
// Codex can hand over argv instead of a script: ["bash", "-lc", "<script>"] is the script; anything else is quoted back.
function shellArgv(argv) {
  if (argv.length === 3 && /(^|\/)(ba|z|da|k)?sh$/.test(argv[0]) && /^-[a-z]*c$/.test(argv[1])) return argv[2];
  return argv.map(a => /^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replaceAll("'", `'\\''`)}'`).join(' ');
}

const git = (cwd, ...args) => spawnSync('git', ['--no-optional-locks', '-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
const out = r => r.status === 0 ? r.stdout.trim() : null;
export function gitProbe(cfg) {
  return {
    root: cwd => fs.existsSync(cwd) ? out(git(cwd, 'rev-parse', '--show-toplevel')) : null,
    // Uncommitted changes to tracked files under the pathspecs (untracked files are not touched by reset or restore).
    dirty: (cwd, specs) => { const r = git(cwd, 'status', '--porcelain', '--untracked-files=no', '--', ...specs); return r.status === 0 ? r.stdout.trim() !== '' : null; },
    // A branch is safe to drop when its tip is on its upstream or on the default branch (local or origin).
    branchSafe: (cwd, b) => {
      if (out(git(cwd, 'rev-parse', '-q', '--verify', `refs/heads/${b}`)) === null) return null;
      for (const t of [`${b}@{upstream}`, `refs/remotes/origin/${cfg.defaultBranch}`, `refs/heads/${cfg.defaultBranch}`]) {
        const sha = out(git(cwd, 'rev-parse', '-q', '--verify', `${t}^{commit}`));
        if (sha && git(cwd, 'merge-base', '--is-ancestor', `refs/heads/${b}`, sha).status === 0) return true;
      }
      return false;
    },
    read: abs => { try { return fs.statSync(abs).isFile() ? fs.readFileSync(abs, 'utf8') : null; } catch { return null; } },
    real: abs => { try { return fs.realpathSync(abs); } catch { return null; } },
  };
}

// One hook call: stdin text in, { stdout, stderr } out. Never throws.
async function run(toolName, stdin, here) {
  const tool = TOOLS[toolName];
  try {
    if (!tool) throw new Error(`unknown tool ${JSON.stringify(toolName)} (expected ${Object.keys(TOOLS).join(', ')})`);
    const req = tool.request(JSON.parse(stdin));
    if (!req) return { stdout: tool.allow, stderr: '' };
    const { decide } = await import(path.join(here, 'guard.mjs'));
    const c = JSON.parse(fs.readFileSync(path.join(here, 'config.json'), 'utf8'));
    const cfg = { rewrite: c.rewrite_pushed, defaultBranch: c.default_branch, protected: c.protected_branches };
    const d = decide(req, cfg, gitProbe(cfg));
    return d.allow ? { stdout: tool.allow, stderr: '' } : { stdout: tool.deny(d.reason), stderr: '' };
  } catch (e) {
    return { stdout: tool?.allow ?? '', stderr: `eng guard: internal error, so this call is allowed (the guard fails open): ${e?.message ?? e}\n` };
  }
}

const self = fileURLToPath(import.meta.url);
const main = () => { try { return fs.realpathSync(process.argv[1]) === self; } catch { return false; } };
if (process.argv[1] && main()) {
  let stdin = '';
  try { stdin = fs.readFileSync(0, 'utf8'); } catch {}
  const r = await run(process.argv[2], stdin, path.dirname(self));
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  process.exitCode = 0;
}
