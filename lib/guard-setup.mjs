// Safe YOLO lite setup (Matt, 11 Nov 2026): what eng sync renders for the guard, and what eng doctor reports about its
// wiring. eng treats tool hook files like skill folders: it renders the guard and each tool's hook config into its own
// folder (.eng/guard) and never writes into .codex or .cursor. eng doctor names the one link or entry that wires each
// tool. The exception is .claude/settings.json, which eng already renders in full, so Claude Code's hook goes there.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GUARD_DIR, HOOK_SCRIPT } from './guard.mjs';
import { fsProbe, q } from './skill-visibility.mjs';

const LIB = path.dirname(fileURLToPath(import.meta.url));
export const guardOn = cfg => cfg?.guard !== 'off';
export const guardErrors = cfg => cfg?.guard === undefined || cfg.guard === 'on' || cfg.guard === 'off' ? []
  : [`guard must be on or off (got ${JSON.stringify(cfg.guard)}). on is the default; off turns off the repo-level guard, and eng doctor lists it as a gate below the standard default`];

// What each tool runs. Claude Code sets CLAUDE_PROJECT_DIR to the project root. Codex runs the hook from the session's
// folder, which can be below the root. Cursor runs project hooks from the project root.
export const GUARD_COMMANDS = {
  'claude-code': `node "$CLAUDE_PROJECT_DIR/${HOOK_SCRIPT}" claude-code`,
  codex: `node "$(git rev-parse --show-toplevel)/${HOOK_SCRIPT}" codex`,
  cursor: `node ${HOOK_SCRIPT} cursor`,
};
export const HOOK_ENTRIES = {
  'claude-code': { matcher: 'Bash|Edit|MultiEdit|Write', hooks: [{ type: 'command', command: GUARD_COMMANDS['claude-code'], timeout: 10 }] },
  codex: { matcher: 'Bash', hooks: [{ type: 'command', command: GUARD_COMMANDS.codex, timeout: 10 }] },
  cursor: { command: GUARD_COMMANDS.cursor, timeout: 10 },
};
// The tool's own hook file, the file eng renders for it, and the event its entry goes under.
export const HOOK_LINKS = {
  codex: { file: '.codex/hooks.json', src: `${GUARD_DIR}/codex-hooks.json`, event: 'PreToolUse', trust: 'Codex runs a repo hook only after you trust it once in /hooks; eng cannot see whether you did' },
  cursor: { file: '.cursor/hooks.json', src: `${GUARD_DIR}/cursor-hooks.json`, event: 'beforeShellExecution', trust: 'Cursor runs project hooks only in a trusted workspace' },
};
const json = v => `${JSON.stringify(v, null, 2)}\n`;

// The files eng sync renders into .eng/guard: the policy and hook script (this package's own code, unchanged after the
// header), the repo's settings, and one hook file per tool for the developer to link or copy from.
export function guardFiles(cfg, header, protectedBranches) {
  if (!guardOn(cfg)) return {};
  const code = f => `${header}\n${fs.readFileSync(path.join(LIB, f), 'utf8')}`;
  return {
    [`${GUARD_DIR}/guard.mjs`]: code('guard.mjs'),
    [HOOK_SCRIPT]: code('guard-hook.mjs'),
    [`${GUARD_DIR}/config.json`]: json({ rewrite_pushed: cfg.git?.rewrite_pushed ?? 'never', default_branch: cfg.project.default_branch, protected_branches: protectedBranches }),
    [HOOK_LINKS.codex.src]: json({ hooks: { PreToolUse: [HOOK_ENTRIES.codex] } }),
    [HOOK_LINKS.cursor.src]: json({ version: 1, hooks: { beforeShellExecution: [HOOK_ENTRIES.cursor] } }),
  };
}

// ---------- eng doctor ----------

// Reads only, like the skills probe, plus reading a regular file's text.
export function guardProbe(root) {
  const p = fsProbe(root);
  return { ...p, read: rel => p.readable(rel) ? fs.readFileSync(path.join(root, rel), 'utf8') : null };
}

// Per tool: wired or not, and the one instruction that wires it. harnesses: agents.harnesses.
export function guardWiring({ cfg, probe }) {
  if (!guardOn(cfg)) return { on: false, tools: [] };
  const hs = cfg.agents?.harnesses ?? [];
  const rendered = probe.readable(HOOK_SCRIPT);
  const claude = () => {
    if (!hs.includes('claude-code')) return { tool: 'claude-code', wired: false, text: 'not wired: eng writes its hook into .claude/settings.json only when claude-code is in agents.harnesses', fix: 'add claude-code to agents.harnesses, then run eng sync' };
    return (probe.read('.claude/settings.json') ?? '').includes(HOOK_SCRIPT)
      ? { tool: 'claude-code', wired: true, text: 'wired (PreToolUse in .claude/settings.json: shell commands, Edit and Write)' }
      : { tool: 'claude-code', wired: false, text: 'not wired: .claude/settings.json does not run the guard', fix: 'run eng sync' };
  };
  const root = probe.real('.') ?? probe.root;
  const linked = (tool) => {
    const L = HOOK_LINKS[tool], e = probe.entry(L.file), entry = JSON.stringify(HOOK_ENTRIES[tool]);
    const dir = path.dirname(L.file), up = probe.entry(dir);
    const link = () => `${up.kind === 'absent' ? `mkdir -p ${q(dir)} && ` : ''}ln -s ${q(path.relative(probe.real(dir) ?? path.join(root, dir), path.join(root, L.src)))} ${q(L.file)}`;
    if (e.kind === 'absent') {
      if (up.kind === 'link' && up.broken || !['absent', 'folder', 'link'].includes(up.kind)) return { tool, wired: false, text: `not wired: ${dir} is ${up.kind === 'link' ? 'a broken link' : `a ${up.kind}`}, so no hook file can go inside it`, fix: `move ${dir} aside or repair it, then run eng doctor again` };
      return { tool, wired: false, text: `not wired: ${L.file} is absent`, fix: `${link()}. ${L.trust}` };
    }
    if (e.kind === 'link' && e.broken) return { tool, wired: false, text: `not wired: ${L.file} is a broken link to ${e.to}`, fix: `point it at eng's file: rm ${q(L.file)} && ${link()}. ${L.trust}` };
    const real = probe.real(L.file), ours = probe.real(L.src);
    if (real && ours && real === ours || new RegExp(`hook\\.mjs[\\\\"]* ${tool}\\b`).test(probe.read(L.file) ?? ''))
      return { tool, wired: true, text: `wired (${L.file}${e.kind === 'link' ? ` links to ${e.to}` : ' has eng\'s entry'}). ${L.trust}` };
    return { tool, wired: false, text: `not wired: ${L.file} is the repo's own ${e.kind === 'link' ? `link (to ${e.to})` : 'file'} and has no eng entry`, fix: `add this entry to its hooks.${L.event} list: ${entry}. ${L.trust}` };
  };
  return { on: true, rendered, tools: [claude(), linked('codex'), linked('cursor')].map(t => ({ ...t, listed: hs.includes(t.tool) })) };
}

export const GUARD_NOT_COVERED = 'Not covered: file edits in Codex and Cursor (their hooks see shell commands only), what the shell parser cannot see (variables, aliases, functions, scripts and programs that run git themselves), and anything outside this repo.';

// The eng doctor section. Informational: it never changes doctor's exit code.
export function guardReport(w) {
  if (!w.on) return '  Guard: off (guard: off in eng.config.yml). Nothing blocks history rewrites, skipped checks or lost local work before a command runs; the git hooks and CI still do their part. Restore: remove the line or set guard: on, then run eng sync.';
  const rows = w.tools.map(t => `    ${t.wired ? 'ok  ' : t.listed ? 'WARN' : 'info'} ${t.tool}: ${t.text}${t.fix ? `. To wire it: ${t.fix}` : ''}`);
  const sync = w.rendered ? [] : [`    WARN ${HOOK_SCRIPT} is missing or unreadable: run eng sync`];
  return ['  Guard (blocks history rewrites, skipped checks, lost local work and edits to itself before a command runs; eng renders it into .eng/guard and never writes into .codex or .cursor):', ...sync, ...rows, `    ${GUARD_NOT_COVERED}`].join('\n');
}
